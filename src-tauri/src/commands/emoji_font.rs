//! Finds installed emoji fonts drawn as color bitmaps, which is how Apple's
//! emoji font is built.
//!
//! The web page can only ask for a font by name. The Windows copy of Apple's
//! emoji font calls itself "Segoe UI Emoji", Windows' own emoji font, so it
//! replaces Windows' emoji everywhere and its name says nothing. What tells
//! them apart is the drawing format: Windows' font uses color outlines (COLR),
//! the Apple copy uses bitmaps (CBDT or sbix). Only file headers are read.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorBitmapFont {
    pub family: String,
    pub file: String,
}

/// Families of installed emoji fonts that draw with color bitmaps.
#[tauri::command]
pub async fn color_bitmap_emoji_fonts() -> Vec<ColorBitmapFont> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut found = Vec::new();
        for dir in font_dirs() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                if !is_font_file(&path) {
                    continue;
                }
                if let Some(family) = color_bitmap_family(&path) {
                    found.push(ColorBitmapFont {
                        family,
                        file: path.to_string_lossy().into_owned(),
                    });
                }
            }
        }
        found
    })
    .await
    .unwrap_or_default()
}

fn font_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if cfg!(target_os = "windows") {
        // Fonts installed "for me" first, then "for all users".
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(local).join("Microsoft").join("Windows").join("Fonts"));
        }
        if let Some(windir) = std::env::var_os("WINDIR") {
            dirs.push(PathBuf::from(windir).join("Fonts"));
        }
    }
    dirs
}

fn is_font_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("ttf") || ext.eq_ignore_ascii_case("otf"))
}

fn color_bitmap_family(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let mut header = [0u8; 12];
    file.read_exact(&mut header).ok()?;
    let version = u32::from_be_bytes(header[0..4].try_into().ok()?);
    // TrueType, OpenType with CFF, or Apple's 'true'. Collections are skipped.
    if !matches!(version, 0x0001_0000 | 0x4F54_544F | 0x7472_7565) {
        return None;
    }
    let count = u16::from_be_bytes([header[4], header[5]]) as usize;
    let mut directory = vec![0u8; count * 16];
    file.read_exact(&mut directory).ok()?;
    let tables = parse_directory(&directory);
    if !tables.iter().any(|(tag, _, _)| tag == b"CBDT" || tag == b"sbix") {
        return None;
    }
    let (_, offset, length) = tables.iter().find(|(tag, _, _)| tag == b"name")?;
    if *length > 1 << 20 {
        return None;
    }
    let mut name = vec![0u8; *length as usize];
    file.seek(SeekFrom::Start(*offset as u64)).ok()?;
    file.read_exact(&mut name).ok()?;
    family_from_name_table(&name)
}

fn parse_directory(directory: &[u8]) -> Vec<([u8; 4], u32, u32)> {
    directory
        .chunks_exact(16)
        .map(|record| {
            let tag = [record[0], record[1], record[2], record[3]];
            let offset = u32::from_be_bytes([record[8], record[9], record[10], record[11]]);
            let length = u32::from_be_bytes([record[12], record[13], record[14], record[15]]);
            (tag, offset, length)
        })
        .collect()
}

/// The family name (16 if present, else 1), preferring Windows English names.
fn family_from_name_table(name: &[u8]) -> Option<String> {
    let read_u16 = |at: usize| name.get(at..at + 2).map(|b| u16::from_be_bytes([b[0], b[1]]));
    let count = read_u16(2)? as usize;
    let storage = read_u16(4)? as usize;
    let mut best: Option<(u32, String)> = None;
    for index in 0..count {
        let at = 6 + index * 12;
        let platform = read_u16(at)?;
        let language = read_u16(at + 4)?;
        let id = read_u16(at + 6)?;
        let length = read_u16(at + 8)? as usize;
        let offset = read_u16(at + 10)? as usize;
        if id != 1 && id != 16 {
            continue;
        }
        let Some(raw) = name.get(storage + offset..storage + offset + length) else { continue };
        let text = match platform {
            0 | 3 => String::from_utf16(
                &raw.chunks_exact(2).map(|b| u16::from_be_bytes([b[0], b[1]])).collect::<Vec<_>>(),
            )
            .ok()?,
            1 => raw.iter().map(|&b| b as char).collect(),
            _ => continue,
        };
        // Lower is better: typographic family over family, Windows English
        // over other Windows names over Mac names.
        let rank = (if id == 16 { 0 } else { 10 })
            + match (platform, language) {
                (3, 0x409) => 0,
                (3, _) | (0, _) => 1,
                _ => 2,
            };
        if best.as_ref().is_none_or(|(current, _)| rank < *current) {
            best = Some((rank, text.trim().to_string()));
        }
    }
    best.map(|(_, family)| family).filter(|family| !family.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name_table(records: &[(u16, u16, u16, &str)]) -> Vec<u8> {
        let mut body = Vec::new();
        let mut storage = Vec::new();
        for &(platform, language, id, text) in records {
            let raw: Vec<u8> = if platform == 1 {
                text.bytes().collect()
            } else {
                text.encode_utf16().flat_map(|unit| unit.to_be_bytes()).collect()
            };
            for value in [platform, if platform == 3 { 1 } else { 0 }, language, id] {
                body.extend_from_slice(&value.to_be_bytes());
            }
            body.extend_from_slice(&(raw.len() as u16).to_be_bytes());
            body.extend_from_slice(&(storage.len() as u16).to_be_bytes());
            storage.extend_from_slice(&raw);
        }
        let mut table = Vec::new();
        table.extend_from_slice(&0u16.to_be_bytes());
        table.extend_from_slice(&(records.len() as u16).to_be_bytes());
        table.extend_from_slice(&((6 + body.len()) as u16).to_be_bytes());
        table.extend_from_slice(&body);
        table.extend_from_slice(&storage);
        table
    }

    fn font(tags: &[&[u8; 4]], name: &[u8]) -> Vec<u8> {
        let mut tags: Vec<&[u8; 4]> = tags.to_vec();
        tags.push(b"name");
        let mut out = Vec::new();
        out.extend_from_slice(&0x0001_0000u32.to_be_bytes());
        out.extend_from_slice(&(tags.len() as u16).to_be_bytes());
        out.extend_from_slice(&[0; 6]);
        let data_start = 12 + 16 * tags.len();
        for tag in &tags {
            out.extend_from_slice(*tag);
            out.extend_from_slice(&[0; 4]);
            let (offset, length) = if *tag == b"name" { (data_start, name.len()) } else { (data_start, 0) };
            out.extend_from_slice(&(offset as u32).to_be_bytes());
            out.extend_from_slice(&(length as u32).to_be_bytes());
        }
        out.extend_from_slice(name);
        out
    }

    fn write_temp(bytes: &[u8], file: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fg-emoji-font-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(file);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn the_windows_copy_of_apple_emoji_is_found_under_its_segoe_name() {
        let name = name_table(&[(1, 0, 1, "Segoe UI Emoji"), (3, 0x409, 1, "Segoe UI Emoji")]);
        let path = write_temp(&font(&[b"CBDT", b"CBLC"], &name), "apple-windows.ttf");
        assert_eq!(color_bitmap_family(&path).as_deref(), Some("Segoe UI Emoji"));
    }

    #[test]
    fn windows_own_emoji_font_draws_with_outlines_and_is_left_out() {
        let name = name_table(&[(3, 0x409, 1, "Segoe UI Emoji")]);
        let path = write_temp(&font(&[b"COLR", b"CPAL"], &name), "segoe.ttf");
        assert_eq!(color_bitmap_family(&path), None);
    }

    #[test]
    fn the_typographic_windows_english_name_wins() {
        let name = name_table(&[
            (1, 0, 1, "Mac Name"),
            (3, 0x40C, 1, "Nom"),
            (3, 0x409, 1, "Family"),
            (3, 0x409, 16, "Apple Color Emoji"),
        ]);
        assert_eq!(family_from_name_table(&name).as_deref(), Some("Apple Color Emoji"));
    }

    #[test]
    fn a_mac_only_name_is_still_read() {
        let name = name_table(&[(1, 0, 1, "Apple Color Emoji")]);
        let path = write_temp(&font(&[b"sbix"], &name), "apple-mac.ttf");
        assert_eq!(color_bitmap_family(&path).as_deref(), Some("Apple Color Emoji"));
    }

    #[test]
    fn broken_files_are_skipped() {
        let path = write_temp(b"not a font", "broken.ttf");
        assert_eq!(color_bitmap_family(&path), None);
        assert!(!is_font_file(Path::new("x.ttc")));
        assert!(is_font_file(Path::new("x.TTF")));
    }
}
