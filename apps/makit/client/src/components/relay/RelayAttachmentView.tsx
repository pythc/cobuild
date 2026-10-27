import { useEffect, useState } from 'react';
import { FileText, LoaderCircle } from 'lucide-react';
import type { RelayAttachment } from '@shared/api.interface';
import { downloadRelayResource, relayResource } from './relay-resource';

export function RelayAttachmentView({ file }: { file: RelayAttachment }) {
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (file.kind !== 'image' || !file.url) return;
    const abort = new AbortController();
    let objectUrl = '';
    setPreview('');
    setError('');
    void relayResource(file.url, abort.signal)
      .then((blob) => {
        if (abort.signal.aborted) return;
        if (!/^image\/(png|jpeg|gif|webp)(;|$)/i.test(blob.type))
          throw new Error('图片格式无法预览');
        objectUrl = URL.createObjectURL(blob);
        setPreview(objectUrl);
      })
      .catch(() => {
        if (!abort.signal.aborted) setError('图片加载失败，可点击下载重试');
      });
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.kind, file.url]);
  return (
    <div className="mt-2">
      <button
        type="button"
        disabled={busy}
        className="block max-w-full break-all text-left text-primary underline-offset-4 hover:underline"
        onClick={() => {
          if (!file.url) return;
          setBusy(true);
          setError('');
          void downloadRelayResource(file.url, file.name)
            .catch(() => setError('附件下载失败，请重试'))
            .finally(() => setBusy(false));
        }}
      >
        {file.kind === 'image' && preview ? (
          <img
            src={preview}
            alt={file.name}
            className="max-h-48 max-w-full rounded-lg object-contain"
          />
        ) : (
          <span className="flex items-center gap-2">
            {busy ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <FileText className="size-4" />
            )}
            {file.name}
          </span>
        )}
      </button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
