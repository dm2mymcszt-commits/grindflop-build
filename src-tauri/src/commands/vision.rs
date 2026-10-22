//! Looks at a photo on the device and reports the body parts and faces in it.
//!
//! This is what the explicit-photo filter and the faceless-profile rule are
//! built on. Nothing here decides anything: it returns what the detector saw
//! and how sure it was, and the frontend applies the thresholds. The photo
//! never leaves the device.
//!
//! The model is NudeNet's 320n detector (YOLOv8n, AGPL-3.0), run with tract so
//! the same pure-Rust code path serves Windows, iOS and Android.

use std::io::Cursor;
use std::sync::OnceLock;
use std::time::Instant;

use base64::Engine;
use serde::Serialize;
use tract_onnx::prelude::*;

const MODEL_BYTES: &[u8] = include_bytes!("../../models/nudenet-320n.onnx");
const INPUT_SIZE: usize = 320;

/// Candidates below this are dropped here. Deliberately lower than anything
/// the frontend acts on, so it can keep a wide "not sure" band of its own.
const MIN_SCORE: f32 = 0.1;
const NMS_IOU: f32 = 0.45;

/// A tile's side, as a share of the photo's shorter side, and how far apart
/// tiles start, as a share of a tile. Six tiles for a portrait photo.
const TILE_SIDE: f32 = 0.6;
const TILE_STRIDE: f32 = 0.75;
/// Below this a tile is no bigger than what the model sees anyway.
const MIN_TILE_SIDE: u32 = 200;
const MAX_TILES: usize = 12;

/// A photo larger than this in either direction is refused rather than decoded.
const MAX_IMAGE_SIDE: u32 = 12_000;
const MAX_DECODE_BYTES: u64 = 256 * 1024 * 1024;

/// In the model's own output order.
const LABELS: [&str; 18] = [
    "FEMALE_GENITALIA_COVERED",
    "FACE_FEMALE",
    "BUTTOCKS_EXPOSED",
    "FEMALE_BREAST_EXPOSED",
    "FEMALE_GENITALIA_EXPOSED",
    "MALE_BREAST_EXPOSED",
    "ANUS_EXPOSED",
    "FEET_EXPOSED",
    "BELLY_COVERED",
    "FEET_COVERED",
    "ARMPITS_COVERED",
    "ARMPITS_EXPOSED",
    "FACE_MALE",
    "BELLY_EXPOSED",
    "MALE_GENITALIA_EXPOSED",
    "ANUS_COVERED",
    "FEMALE_BREAST_COVERED",
    "BUTTOCKS_COVERED",
];

type Detector = TypedRunnableModel<TypedModel>;

static DETECTOR: OnceLock<Result<Detector, String>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub label: &'static str,
    pub score: f32,
    /// Box in the original photo, as fractions of its width and height.
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionResult {
    pub detections: Vec<Detection>,
    pub image_width: u32,
    pub image_height: u32,
    pub elapsed_ms: u32,
}

fn load_detector() -> Result<Detector, String> {
    let onnx = tract_onnx::onnx().with_ignore_output_shapes(true);
    let mut proto = onnx
        .proto_model_for_read(&mut Cursor::new(MODEL_BYTES))
        .map_err(|e| format!("reading the detector model failed: {e}"))?;
    // The export annotates intermediate shapes with expressions tract cannot
    // parse ("floor(height/2 - 1/2) + 1"). They are hints only; with the input
    // size fixed below tract works every shape out for itself.
    if let Some(graph) = proto.graph.as_mut() {
        graph.value_info.clear();
    }
    onnx.model_for_proto_model(&proto)
        .and_then(|model| {
            model.with_input_fact(0, f32::fact([1, 3, INPUT_SIZE, INPUT_SIZE]).into())
        })
        .and_then(|model| model.into_optimized())
        .and_then(|model| model.into_runnable())
        .map_err(|e| format!("preparing the detector model failed: {e}"))
}

fn detector() -> Result<&'static Detector, String> {
    DETECTOR
        .get_or_init(load_detector)
        .as_ref()
        .map_err(|e| e.clone())
}

fn decode_image(bytes: &[u8]) -> Result<image::RgbImage, String> {
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("unreadable image: {e}"))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_SIDE);
    limits.max_image_height = Some(MAX_IMAGE_SIDE);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    reader
        .decode()
        .map(|image| image.to_rgb8())
        .map_err(|e| format!("could not decode image: {e}"))
}

/// Where the photo sits inside the square the model looks at.
struct Letterbox {
    width: u32,
    height: u32,
    pad_x: u32,
    pad_y: u32,
}

fn letterbox_for(image_width: u32, image_height: u32) -> Letterbox {
    let size = INPUT_SIZE as f32;
    let scale = (size / image_width as f32).min(size / image_height as f32);
    let width = ((image_width as f32 * scale).round() as u32).clamp(1, INPUT_SIZE as u32);
    let height = ((image_height as f32 * scale).round() as u32).clamp(1, INPUT_SIZE as u32);
    Letterbox {
        width,
        height,
        pad_x: (INPUT_SIZE as u32 - width) / 2,
        pad_y: (INPUT_SIZE as u32 - height) / 2,
    }
}

fn intersection_over_union(a: &Detection, b: &Detection) -> f32 {
    let left = a.x.max(b.x);
    let top = a.y.max(b.y);
    let right = (a.x + a.width).min(b.x + b.width);
    let bottom = (a.y + a.height).min(b.y + b.height);
    let intersection = (right - left).max(0.0) * (bottom - top).max(0.0);
    let union = a.width * a.height + b.width * b.height - intersection;
    if union <= 0.0 {
        0.0
    } else {
        intersection / union
    }
}

/// Keeps the strongest box of each overlapping group, one label at a time.
///
/// Per label, unlike the reference implementation: there a confident "belly"
/// box could swallow a weaker "genitalia" box over the same spot, and the
/// weaker one is exactly the one the filter must not lose.
fn suppress_overlaps(mut candidates: Vec<Detection>) -> Vec<Detection> {
    candidates.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Detection> = Vec::new();
    for candidate in candidates {
        let overlaps = kept.iter().any(|existing| {
            existing.label == candidate.label
                && intersection_over_union(existing, &candidate) > NMS_IOU
        });
        if !overlaps {
            kept.push(candidate);
        }
    }
    kept
}

/// A rectangle of the photo, in pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Region {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

/// Where along one side the tiles start, so that they cover it end to end.
fn tile_starts(length: u32, side: u32) -> Vec<u32> {
    if length <= side {
        return vec![0];
    }
    let spare = length - side;
    let steps = (spare as f32 / (side as f32 * TILE_STRIDE)).ceil().max(1.0) as u32;
    (0..=steps).map(|step| spare * step / steps).collect()
}

/// Overlapping square pieces of the photo, each looked at on its own.
///
/// The model sees everything squeezed into 320 pixels, where a face in a
/// full-length photo is a dozen pixels tall and goes unseen. A piece of the
/// photo is squeezed less, so the same face comes out about twice the size.
/// Nothing for a photo already too small for that to help.
fn tile_regions(image_width: u32, image_height: u32) -> Vec<Region> {
    let side = (image_width.min(image_height) as f32 * TILE_SIDE) as u32;
    if side < MIN_TILE_SIDE {
        return Vec::new();
    }
    let mut regions = Vec::new();
    for y in tile_starts(image_height, side) {
        for x in tile_starts(image_width, side) {
            regions.push(Region { x, y, width: side, height: side });
        }
    }
    regions.truncate(MAX_TILES);
    regions
}

/// Runs the model on one region and reports what it found in whole-photo terms.
fn detect_region(
    model: &Detector,
    image: &image::RgbImage,
    region: Region,
) -> Result<Vec<Detection>, String> {
    let (image_width, image_height) = image.dimensions();
    let frame = letterbox_for(region.width, region.height);
    let whole = region.x == 0
        && region.y == 0
        && region.width == image_width
        && region.height == image_height;
    let resized = if whole {
        image::imageops::resize(
            image,
            frame.width,
            frame.height,
            image::imageops::FilterType::Triangle,
        )
    } else {
        let piece =
            image::imageops::crop_imm(image, region.x, region.y, region.width, region.height)
                .to_image();
        image::imageops::resize(
            &piece,
            frame.width,
            frame.height,
            image::imageops::FilterType::Triangle,
        )
    };

    let mut input = tract_ndarray::Array4::<f32>::zeros((1, 3, INPUT_SIZE, INPUT_SIZE));
    for (x, y, pixel) in resized.enumerate_pixels() {
        let column = (x + frame.pad_x) as usize;
        let row = (y + frame.pad_y) as usize;
        for channel in 0..3 {
            input[[0, channel, row, column]] = pixel[channel] as f32 / 255.0;
        }
    }

    let outputs = model
        .run(tvec!(Tensor::from(input).into()))
        .map_err(|e| format!("detector failed: {e}"))?;
    let output = outputs[0]
        .to_array_view::<f32>()
        .map_err(|e| format!("unexpected detector output: {e}"))?;
    // [1, 4 box values + one score per label, candidates]
    let shape = output.shape();
    if shape.len() != 3 || shape[1] != 4 + LABELS.len() {
        return Err(format!("unexpected detector output shape {shape:?}"));
    }

    // From the model's square, to pixels of the region, to fractions of the photo.
    let to_photo_x = |value: f32| {
        let in_region = (value - frame.pad_x as f32) / frame.width as f32 * region.width as f32;
        ((region.x as f32 + in_region) / image_width as f32).clamp(0.0, 1.0)
    };
    let to_photo_y = |value: f32| {
        let in_region = (value - frame.pad_y as f32) / frame.height as f32 * region.height as f32;
        ((region.y as f32 + in_region) / image_height as f32).clamp(0.0, 1.0)
    };

    let mut candidates = Vec::new();
    for index in 0..shape[2] {
        let center_x = output[[0, 0, index]];
        let center_y = output[[0, 1, index]];
        let box_width = output[[0, 2, index]];
        let box_height = output[[0, 3, index]];
        for (label_index, label) in LABELS.iter().enumerate() {
            let score = output[[0, 4 + label_index, index]];
            if score < MIN_SCORE {
                continue;
            }
            let left = to_photo_x(center_x - box_width / 2.0);
            let top = to_photo_y(center_y - box_height / 2.0);
            let right = to_photo_x(center_x + box_width / 2.0);
            let bottom = to_photo_y(center_y + box_height / 2.0);
            candidates.push(Detection {
                label,
                score,
                x: left,
                y: top,
                width: (right - left).max(0.0),
                height: (bottom - top).max(0.0),
            });
        }
    }
    Ok(candidates)
}

fn detect(bytes: &[u8], tiled: bool) -> Result<DetectionResult, String> {
    let started = Instant::now();
    let model = detector()?;
    let image = decode_image(bytes)?;
    let (image_width, image_height) = image.dimensions();
    if image_width == 0 || image_height == 0 {
        return Err("empty image".into());
    }

    let mut regions = vec![Region { x: 0, y: 0, width: image_width, height: image_height }];
    if tiled {
        regions.extend(tile_regions(image_width, image_height));
    }
    let mut candidates = Vec::new();
    for region in regions {
        candidates.extend(detect_region(model, &image, region)?);
    }

    Ok(DetectionResult {
        detections: suppress_overlaps(candidates),
        image_width,
        image_height,
        elapsed_ms: started.elapsed().as_millis().min(u32::MAX as u128) as u32,
    })
}

/// Runs the detector on one image (JPEG, PNG, WebP or the first frame of a
/// GIF), given as base64. An image that cannot be read is an error, never an
/// empty result: "nothing found" has to mean the detector actually looked.
///
/// `tiled` also looks at the photo piece by piece, which finds small things
/// (a face in a full-length photo) at several times the cost.
#[tauri::command]
pub async fn detect_image_content(
    image_base64: String,
    tiled: Option<bool>,
) -> Result<DetectionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(image_base64.trim())
            .map_err(|e| format!("invalid image data: {e}"))?;
        detect(&bytes, tiled.unwrap_or(false))
    })
    .await
    .map_err(|e| format!("detector task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn boxed(label: &'static str, score: f32, x: f32, y: f32) -> Detection {
        Detection { label, score, x, y, width: 0.2, height: 0.2 }
    }

    fn png(image: &image::RgbImage) -> Vec<u8> {
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgb8(image.clone())
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        bytes
    }

    #[test]
    fn letterbox_keeps_the_photo_centred_and_inside_the_square() {
        let tall = letterbox_for(1080, 2160);
        assert_eq!((tall.width, tall.height), (160, 320));
        assert_eq!((tall.pad_x, tall.pad_y), (80, 0));

        let wide = letterbox_for(4000, 1000);
        assert_eq!((wide.width, wide.height), (320, 80));
        assert_eq!((wide.pad_x, wide.pad_y), (0, 120));

        let sliver = letterbox_for(10_000, 3);
        assert_eq!(sliver.height, 1);
    }

    #[test]
    fn overlapping_boxes_of_one_label_collapse_to_the_strongest() {
        let kept = suppress_overlaps(vec![
            boxed("FACE_MALE", 0.4, 0.10, 0.10),
            boxed("FACE_MALE", 0.9, 0.11, 0.10),
            boxed("FACE_MALE", 0.6, 0.60, 0.60),
        ]);
        let scores: Vec<f32> = kept.iter().map(|d| d.score).collect();
        assert_eq!(scores, vec![0.9, 0.6]);
    }

    #[test]
    fn a_stronger_box_of_another_label_does_not_hide_a_weaker_one() {
        let kept = suppress_overlaps(vec![
            boxed("BELLY_EXPOSED", 0.9, 0.10, 0.10),
            boxed("MALE_GENITALIA_EXPOSED", 0.3, 0.10, 0.10),
        ]);
        assert_eq!(kept.len(), 2);
    }

    #[test]
    fn the_bundled_model_loads_and_finds_nothing_in_a_blank_photo() {
        let blank = image::RgbImage::from_pixel(64, 48, image::Rgb([120, 120, 120]));
        let result = detect(&png(&blank), false).expect("the detector runs");
        assert_eq!((result.image_width, result.image_height), (64, 48));
        assert!(result.detections.is_empty(), "{:?}", result.detections);
    }

    #[test]
    fn tiles_cover_the_photo_edge_to_edge() {
        let regions = tile_regions(768, 1024);
        assert_eq!(regions.len(), 6);
        assert!(regions.iter().all(|r| r.width == 460 && r.height == 460));
        assert!(regions.iter().any(|r| r.x == 0 && r.y == 0));
        assert!(regions.iter().any(|r| r.x + r.width == 768 && r.y + r.height == 1024));

        assert_eq!(tile_starts(1024, 460), vec![0, 282, 564]);
        assert_eq!(tile_starts(300, 460), vec![0]);
    }

    #[test]
    fn a_small_photo_is_not_tiled() {
        assert!(tile_regions(320, 320).is_empty());
    }

    /// The one photo of a person in the repository is the avatar in a docs
    /// screenshot. Pasted small into a large blank photo, it stands in for a
    /// face in a full-length picture: the case tiling exists for.
    fn small_face_in_a_large_photo() -> Vec<u8> {
        let screenshot = image::load_from_memory(include_bytes!(
            "../../../docs/content/images/mobile/browse.png"
        ))
        .unwrap()
        .to_rgb8();
        let avatar = image::imageops::crop_imm(&screenshot, 900, 35, 145, 145).to_image();
        let avatar =
            image::imageops::resize(&avatar, 400, 400, image::imageops::FilterType::Lanczos3);
        let mut photo = image::RgbImage::from_pixel(1200, 1600, image::Rgb([110, 110, 110]));
        image::imageops::replace(&mut photo, &avatar, 700, 100);
        png(&photo)
    }

    fn strongest_face(result: &DetectionResult) -> Option<&Detection> {
        result
            .detections
            .iter()
            .filter(|d| d.label.starts_with("FACE_"))
            .max_by(|a, b| a.score.total_cmp(&b.score))
    }

    #[test]
    fn tiling_finds_a_small_face_and_places_it_in_the_whole_photo() {
        let photo = small_face_in_a_large_photo();
        let whole = detect(&photo, false).expect("the detector runs");
        let tiled = detect(&photo, true).expect("the detector runs");

        let whole_score = strongest_face(&whole).map_or(0.0, |d| d.score);
        let found = strongest_face(&tiled).expect("tiling finds the face");
        // A weak score is expected: the face in that avatar is under a cosmetic mask.
        assert!(found.score >= 0.15, "{found:?}");
        assert!(found.score > whole_score, "whole {whole_score}, tiled {}", found.score);

        // The avatar was pasted at x 700..1100 of 1200 and y 100..500 of 1600.
        let center_x = found.x + found.width / 2.0;
        let center_y = found.y + found.height / 2.0;
        assert!((0.58..0.92).contains(&center_x), "{found:?}");
        assert!((0.06..0.32).contains(&center_y), "{found:?}");
    }

    /// Not a test: prints what the detector finds in a photo on disk, whole
    /// and tiled, for tuning the thresholds against a real case.
    ///
    /// FG_PROBE_IMAGE=path cargo test --lib probe_a_photo -- --ignored --nocapture
    #[test]
    #[ignore]
    fn probe_a_photo_from_disk() {
        let path = std::env::var("FG_PROBE_IMAGE").expect("set FG_PROBE_IMAGE to a photo");
        let bytes = std::fs::read(&path).expect("the photo can be read");
        for tiled in [false, true] {
            let result = detect(&bytes, tiled).expect("the detector runs");
            println!(
                "{path} ({}x{}) tiled={tiled} in {} ms",
                result.image_width, result.image_height, result.elapsed_ms
            );
            for found in &result.detections {
                println!(
                    "  {:<26} {:.3}  x={:.2} y={:.2} w={:.2} h={:.2}",
                    found.label, found.score, found.x, found.y, found.width, found.height
                );
            }
        }
    }

    #[test]
    fn unreadable_bytes_are_an_error_not_an_empty_result() {
        assert!(detect(b"definitely not an image", false).is_err());
        assert!(detect(b"definitely not an image", true).is_err());
    }
}
