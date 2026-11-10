// Things only the desktop window can do. The browser-only mode simply doesn't have them.
let hooks = null;

export const setDesktopHooks = (value) => { hooks = value; };
export const desktop = () => hooks;

/** A second copy of the app, used for testing, must not run schedules or restart anything. */
export const isSecondary = () => process.env.QBC_SECONDARY === '1';
