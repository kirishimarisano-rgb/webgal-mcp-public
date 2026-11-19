import { realpath, stat } from 'node:fs/promises';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import { AppError } from './errors.js';
import { LIMITS, type ProjectConfig } from './types.js';

const API_TEST_SIGNATURE = 'WebGAL Terre Application API Test OK';
const OPENAPI_TITLE = 'WebGAL Terre API';
const LOOPBACK_ROOT_URL =
  /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?\/?$/i;

export type TerreCapabilityState = 'available' | 'unavailable' | 'unknown';
export type TerreCompatibility = 'compatible' | 'incompatible' | 'unknown';

export interface TerreCapabilities {
  apiTest: TerreCapabilityState;
  openApi: TerreCapabilityState;
  readGameAssets: TerreCapabilityState;
  preview: TerreCapabilityState;
}

export interface TerreInspection {
  reachable: boolean;
  compatibility: TerreCompatibility;
  capabilities: TerreCapabilities;
  mappingVerified: boolean;
  version: 'unknown';
}

type RequestFailureKind = 'network' | 'timeout' | 'too_large';

class TerreRequestError extends Error {
  constructor(
    readonly kind: RequestFailureKind,
    readonly responded: boolean,
  ) {
    super(kind);
    this.name = 'TerreRequestError';
  }
}

interface HttpTextResponse {
  status: number;
  body: string;
}

interface ReadGameAssetsResponse {
  readDirPath: string;
  dirPath: string;
  dirInfo: unknown[];
}

export function normalizeTerreUrl(input: string): string {
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    input !== input.trim() ||
    input.includes('\\') ||
    input.includes('%') ||
    !LOOPBACK_ROOT_URL.test(input)
  ) {
    throw invalidTerreUrl();
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw invalidTerreUrl();
  }

  if (
    parsed.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.pathname !== '/'
  ) {
    throw invalidTerreUrl();
  }

  return parsed.origin;
}

export async function inspectTerre(project: ProjectConfig): Promise<TerreInspection> {
  const hasMapping = Boolean(project.terreGameDir?.trim());
  const capabilities = initialCapabilities(hasMapping);

  if (!project.terreUrl?.trim()) {
    return inspectionResult(false, capabilities, false);
  }

  const baseUrl = normalizeTerreUrl(project.terreUrl);
  let reachable = false;

  let apiTestResponse: HttpTextResponse;
  try {
    apiTestResponse = await getText(baseUrl, '/api/test');
    reachable = true;
  } catch (error) {
    const responded = error instanceof TerreRequestError && error.responded;
    reachable = responded;
    capabilities.apiTest = 'unavailable';
    return inspectionResult(
      reachable,
      capabilities,
      false,
      responded ? 'incompatible' : 'unknown',
    );
  }

  const apiTestOk =
    apiTestResponse.status === 200 && apiTestResponse.body === API_TEST_SIGNATURE;
  capabilities.apiTest = apiTestOk ? 'available' : 'unavailable';

  let openApiOk = false;
  try {
    const openApiResponse = await getText(baseUrl, '/api-json');
    openApiOk =
      openApiResponse.status === 200 && isCompatibleOpenApi(openApiResponse.body);
    capabilities.openApi = openApiOk ? 'available' : 'unavailable';
  } catch {
    capabilities.openApi = 'unavailable';
  }

  let mappingVerified = false;
  if (hasMapping) {
    const encodedGameDir = encodeURIComponent(project.terreGameDir!);
    try {
      const response = await getText(
        baseUrl,
        `/api/manageGame/readGameAssets/${encodedGameDir}/game/scene`,
      );
      const listing =
        response.status === 200 ? parseReadGameAssets(response.body) : undefined;

      if (!listing) {
        capabilities.readGameAssets = 'unavailable';
      } else {
        capabilities.readGameAssets = 'available';
        mappingVerified = await verifySceneMapping(project, listing);
      }
    } catch {
      capabilities.readGameAssets = 'unavailable';
    }
  }

  const requiredApisOk = apiTestOk && openApiOk;
  const readAssetsOk =
    !hasMapping || capabilities.readGameAssets === 'available';
  const compatibility =
    requiredApisOk && readAssetsOk ? 'unknown' : 'incompatible';

  return inspectionResult(
    reachable,
    capabilities,
    mappingVerified,
    compatibility,
  );
}

export function previewUrl(project: ProjectConfig): string {
  if (!project.terreUrl?.trim() || !project.terreGameDir?.trim()) {
    throw new AppError(
      'CONFIG_REQUIRED',
      'Terre URL and game directory mapping are required.',
    );
  }

  const baseUrl = normalizeTerreUrl(project.terreUrl);
  return `${baseUrl}/games/${encodeURIComponent(project.terreGameDir)}/`;
}

function invalidTerreUrl(): AppError {
  return new AppError(
    'CONFIG_INVALID',
    'Terre URL must be an HTTP loopback root URL without credentials, query, fragment, or encoded path.',
  );
}

function initialCapabilities(hasMapping: boolean): TerreCapabilities {
  return {
    apiTest: 'unknown',
    openApi: 'unknown',
    readGameAssets: hasMapping ? 'unknown' : 'unavailable',
    preview: hasMapping ? 'unknown' : 'unavailable',
  };
}

function inspectionResult(
  reachable: boolean,
  capabilities: TerreCapabilities,
  mappingVerified: boolean,
  compatibility: TerreCompatibility = 'unknown',
): TerreInspection {
  return {
    reachable,
    compatibility,
    capabilities,
    mappingVerified,
    version: 'unknown',
  };
}

function getText(baseUrl: string, path: string): Promise<HttpTextResponse> {
  const url = new URL(path, `${baseUrl}/`);

  return new Promise((resolvePromise, rejectPromise) => {
    let request: ClientRequest | undefined;
    let responded = false;
    let settled = false;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const fail = (kind: RequestFailureKind): void => {
      finish(() => {
        rejectPromise(new TerreRequestError(kind, responded));
        request?.destroy();
      });
    };

    const timer = setTimeout(() => fail('timeout'), LIMITS.timeoutMs);

    request = httpRequest(
      url,
      {
        method: 'GET',
        agent: false,
        headers: {
          accept: '*/*',
          connection: 'close',
        },
      },
      (response: IncomingMessage) => {
        responded = true;
        const status = response.statusCode ?? 0;

        if (status < 200 || status >= 300) {
          finish(() => resolvePromise({ status, body: '' }));
          response.destroy();
          return;
        }

        const declaredLength = Number(response.headers['content-length']);
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > LIMITS.responseBytes
        ) {
          fail('too_large');
          response.destroy();
          return;
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;

        response.on('data', (chunk: Buffer | string) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.length;
          if (totalBytes > LIMITS.responseBytes) {
            fail('too_large');
            response.destroy();
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () => {
          finish(() =>
            resolvePromise({
              status,
              body: Buffer.concat(chunks, totalBytes).toString('utf8'),
            }),
          );
        });
        response.on('aborted', () => fail('network'));
        response.on('error', () => fail('network'));
      },
    );

    request.on('error', () => fail('network'));
    request.end();
  });
}

function isCompatibleOpenApi(body: string): boolean {
  const value = parseJson(body);
  if (!isRecord(value) || !isRecord(value.info) || !isRecord(value.paths)) {
    return false;
  }

  return (
    typeof value.openapi === 'string' &&
    value.openapi.startsWith('3.') &&
    value.info.title === OPENAPI_TITLE &&
    hasGetOperation(value.paths['/api/test']) &&
    hasGetOperation(value.paths['/api/manageGame/readGameAssets/{readDirPath}'])
  );
}

function parseReadGameAssets(body: string): ReadGameAssetsResponse | undefined {
  const value = parseJson(body);
  if (
    !isRecord(value) ||
    typeof value.readDirPath !== 'string' ||
    typeof value.dirPath !== 'string' ||
    !Array.isArray(value.dirInfo) ||
    !value.dirInfo.every(isDirInfo)
  ) {
    return undefined;
  }

  return {
    readDirPath: value.readDirPath,
    dirPath: value.dirPath,
    dirInfo: value.dirInfo,
  };
}

async function verifySceneMapping(
  project: ProjectConfig,
  listing: ReadGameAssetsResponse,
): Promise<boolean> {
  const expectedReadDirPath = `${project.terreGameDir}/game/scene`;
  if (listing.readDirPath.replaceAll('\\', '/') !== expectedReadDirPath.replaceAll('\\', '/')) {
    return false;
  }
  if (!isAbsolute(listing.dirPath)) {
    return false;
  }

  const expectedPath = resolve(project.root, 'game', 'scene');
  try {
    const [expectedRealPath, actualRealPath] = await Promise.all([
      realpath(expectedPath),
      realpath(resolve(listing.dirPath)),
    ]);
    if (!samePath(expectedRealPath, actualRealPath)) {
      return false;
    }
    return (await stat(expectedRealPath)).isDirectory();
  } catch {
    return false;
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isDirInfo(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.isDir === 'boolean' &&
    typeof value.extName === 'string' &&
    typeof value.path === 'string' &&
    (value.size === undefined || typeof value.size === 'number') &&
    (value.lastModified === undefined || typeof value.lastModified === 'number')
  );
}

function hasGetOperation(value: unknown): boolean {
  return isRecord(value) && isRecord(value.get);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}
