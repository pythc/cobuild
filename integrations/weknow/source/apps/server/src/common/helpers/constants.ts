import * as path from 'path';

export const APP_DATA_PATH = 'data';
const LOCAL_STORAGE_DIR = `${APP_DATA_PATH}/storage`;

export const LOCAL_STORAGE_PATH = process.env.COBUILD_IDENTITY_MODE === 'local'
  ? path.resolve(process.env.COBUILD_STORAGE_PATH || (() => { throw new Error('Explicit local storage required'); })())
  : path.resolve(process.cwd(), '..', '..', LOCAL_STORAGE_DIR);

export function getPageTitle(
  title: string | null | undefined,
  isBase?: boolean,
): string {
  return title || (isBase ? 'Untitled base' : 'untitled');
}
