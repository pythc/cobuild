import type {
  McpCredentialExchangeInput,
  McpCredentialResponse,
  McpEncryptedCredentialResponse,
} from '@shared/api.interface';

interface McpCredentialExchange {
  input: McpCredentialExchangeInput;
  decrypt(
    response: McpEncryptedCredentialResponse,
  ): Promise<McpCredentialResponse>;
}

function toBase64Url(value: ArrayBufferLike): string {
  const bytes: Uint8Array = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
}

function fromBase64Url(value: string): ArrayBuffer {
  const normalized: string = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const padding: string = '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary: string = atob(`${normalized}${padding}`);
  const bytes: Uint8Array = Uint8Array.from(
    binary,
    (character: string): number => character.charCodeAt(0),
  );
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function credentialResponse(value: unknown): McpCredentialResponse {
  if (!value || typeof value !== 'object') throw new Error('MCP Key 解密失败');
  const response = value as Partial<McpCredentialResponse>;
  if (
    response.available !== true ||
    response.issued !== true ||
    typeof response.endpoint !== 'string' ||
    typeof response.openApiKey !== 'string' ||
    typeof response.personalToken !== 'string' ||
    typeof response.personalTokenPreview !== 'string' ||
    typeof response.userName !== 'string' ||
    !response.endpoint ||
    !response.openApiKey ||
    !response.personalToken
  ) {
    throw new Error('MCP Key 解密失败');
  }
  return response as McpCredentialResponse;
}

export async function createMcpCredentialExchange(): Promise<McpCredentialExchange> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('当前浏览器不支持安全生成 MCP Key');
  }
  const requestNonce: string = toBase64Url(
    globalThis.crypto.getRandomValues(new Uint8Array(16)).buffer,
  );
  const keyPair: CryptoKeyPair = (await globalThis.crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    false,
    ['encrypt', 'decrypt'],
  )) as CryptoKeyPair;
  const publicKey: ArrayBuffer = await globalThis.crypto.subtle.exportKey(
    'spki',
    keyPair.publicKey,
  );
  return {
    input: { publicKey: toBase64Url(publicKey), requestNonce },
    async decrypt(
      response: McpEncryptedCredentialResponse,
    ): Promise<McpCredentialResponse> {
      if (
        response.version !== 1 ||
        response.algorithm !== 'RSA-OAEP-256+A256GCM' ||
        response.requestNonce !== requestNonce
      ) {
        throw new Error('MCP Key 加密算法不受支持');
      }
      try {
        const contentKey: ArrayBuffer = await globalThis.crypto.subtle.decrypt(
          { name: 'RSA-OAEP' },
          keyPair.privateKey,
          fromBase64Url(response.encryptedKey),
        );
        const aesKey: CryptoKey = await globalThis.crypto.subtle.importKey(
          'raw',
          contentKey,
          { name: 'AES-GCM' },
          false,
          ['decrypt'],
        );
        const plaintext: ArrayBuffer = await globalThis.crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: fromBase64Url(response.iv),
            additionalData: new TextEncoder().encode(
              `mcp-credential-v1\u0000${requestNonce}`,
            ).buffer as ArrayBuffer,
            tagLength: 128,
          },
          aesKey,
          fromBase64Url(response.ciphertext),
        );
        return credentialResponse(
          JSON.parse(new TextDecoder().decode(plaintext)) as unknown,
        );
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('MCP Key')) {
          throw error;
        }
        throw new Error('MCP Key 解密失败');
      }
    },
  };
}
