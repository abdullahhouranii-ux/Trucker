export const APP_CONFIG = Symbol('APP_CONFIG');
export const DB_POOL = Symbol('DB_POOL');
/** Source of the current time. Tests replace it to move time without waiting. */
export const CLOCK = Symbol('CLOCK');
export type Clock = () => Date;
/** Where proof-of-delivery files are kept; null when file storage is closed. */
export const FILE_STORE = Symbol('FILE_STORE');
