'use client';
import { axiosForBackend } from '@/lib/selfhost-http';

export interface UploadFileData {
  id: string;
  filePath: string;
  bucketId: string;
  url: string;
}

export async function uploadFile(file: File): Promise<UploadFileData> {
  const form = new FormData();
  form.append('file', file);
  return (await axiosForBackend.post<UploadFileData>('/api/selfhost/files', form)).data;
}
