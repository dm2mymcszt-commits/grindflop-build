/**
 * CENTRAL CONFIGURATION
 * Tune the app's scrolling feel here.
 */
export const SMOOTH_SCROLL_CONFIG = {
	/**
	 * Whether smooth scrolling is active globally.
	 */
	enabled: true,

	/**
	 * Enable smooth scrolling on touch devices (mobile).
	 */
	smoothTouch: false,

	/**
	 * Skip Lenis entirely on touch-first devices. With `smoothTouch` off it has
	 * no wheel input to smooth there, so it only costs an animation frame loop
	 * and a set of listeners competing with native momentum scrolling.
	 */
	disableOnTouch: true,

	/**
	 * How many consecutive idle frames to run before parking the animation
	 * frame loop. Input and scroll events wake it back up, so this only needs to
	 * outlast the tail of a settling scroll.
	 */
	idleFramesBeforeStop: 8,

	/**
	 * Animation duration in seconds.
	 */
	duration: undefined as number | undefined,

	/**
	 * How much the scroll distance is multiplied for wheel events.
	 */
	wheelMultiplier: 1.2,

	/**
	 * Multiplier for touch events if smoothTouch is true.
	 */
	touchMultiplier: 1.5,

	/**
	 * Linear interpolation (0 to 1). Lower is smoother/slower.
	 */
	lerp: 0.06,
} as const;
