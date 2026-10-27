import axios from 'axios';
import { selfhostAssetReferences } from '@shared/selfhost-assets';
export const axiosForBackend = axios.create({ baseURL: '/', withCredentials: true, timeout: 90000,
  transformResponse: [(data: unknown) => typeof data === 'string' ? selfhostAssetReferences(data) : data,
    ...([axios.defaults.transformResponse].flat().filter(Boolean) as NonNullable<typeof axios.defaults.transformResponse>[]).flat()],
});
// Deliberately omit Axios config/headers, credentials, request bodies and logs.
export const logger = {
  error: (label: string, _error?: unknown) => console.error(label),
};
export const getEnv = () => 'PRODUCTION';
