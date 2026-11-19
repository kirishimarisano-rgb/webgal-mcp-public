import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import { validateRelativePath } from '../filesystem.js';
import {
  WRITE_LIMITS,
  type Attestation,
  type WriteSession
} from './types.js';

interface StoredSession {
  id: string;
  ownerId: string;
  projectId: string;
  paths: string[];
  createdAt: number;
  expiresAt: number;
  state: WriteSession['state'];
  attestation: Attestation;
}

function invalidArgument(message: string): never {
  throw new AppError('INVALID_ARGUMENT', message);
}

function handoffRequired(): never {
  throw new AppError(
    'HANDOFF_REQUIRED',
    'An active user handoff session is required.'
  );
}

function sessionExpired(): never {
  throw new AppError('SESSION_EXPIRED', 'The write session has expired.');
}

function sessionMismatch(): never {
  throw new AppError(
    'SESSION_MISMATCH',
    'The write session does not belong to this owner and project.'
  );
}

function scopeMismatch(): never {
  throw new AppError(
    'SCOPE_MISMATCH',
    'A requested path is outside the write session scope.'
  );
}

function validateIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 128) {
    invalidArgument(`${label} must be a non-empty string.`);
  }
}

function validateAttestation(attestation: unknown): asserts attestation is Attestation {
  if (typeof attestation !== 'object' || attestation === null) {
    handoffRequired();
  }

  const candidate = attestation as Partial<Attestation>;
  if (candidate.source !== 'user-message'
    || typeof candidate.statement !== 'string'
    || candidate.statement.trim() === '' || candidate.statement.length > 2048) {
    handoffRequired();
  }
}

function normalizePaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) {
    invalidArgument('Session paths must be an array.');
  }
  if (paths.length === 0 || paths.length > WRITE_LIMITS.maxFiles) {
    invalidArgument(`A write session may cover at most ${WRITE_LIMITS.maxFiles} files.`);
  }

  return paths.map((candidate) => {
    if (typeof candidate !== 'string' || candidate === '') {
      invalidArgument('Session paths must be non-empty relative paths.');
    }
    return validateRelativePath(candidate);
  });
}

function snapshot(session: StoredSession): WriteSession {
  const paths = Object.freeze([...session.paths]) as unknown as string[];
  return Object.freeze({
    id: session.id,
    ownerId: session.ownerId,
    projectId: session.projectId,
    paths,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    state: session.state,
    attestation: Object.freeze({ ...session.attestation }),
    userAttested: true,
    automaticDirtyCheck: false
  }) as WriteSession;
}

export class SessionManager {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  begin(
    ownerId: string,
    projectId: string,
    attestation: Attestation,
    paths: string[],
    ttlMs: number = WRITE_LIMITS.sessionTtlMs
  ): WriteSession {
    validateIdentifier(ownerId, 'ownerId');
    validateIdentifier(projectId, 'projectId');
    validateAttestation(attestation);
    const normalizedPaths = normalizePaths(paths);

    if (!Number.isSafeInteger(ttlMs)
      || ttlMs <= 0
      || ttlMs > WRITE_LIMITS.maxSessionTtlMs) {
      invalidArgument(
        `Session TTL must be a positive integer no greater than ${WRITE_LIMITS.maxSessionTtlMs}.`
      );
    }

    const createdAt = this.now();
    const session: StoredSession = {
      id: randomUUID(),
      ownerId,
      projectId,
      paths: normalizedPaths,
      createdAt,
      expiresAt: createdAt + ttlMs,
      state: 'active',
      attestation: { source: attestation.source, statement: attestation.statement }
    };
    this.sessions.set(session.id, session);
    return snapshot(session);
  }

  require(
    id: string,
    ownerId: string,
    projectId: string,
    paths: string[]
  ): WriteSession {
    const session = this.sessions.get(id);
    if (!session || session.state !== 'active') {
      handoffRequired();
    }
    if (this.now() >= session.expiresAt) {
      sessionExpired();
    }
    if (session.ownerId !== ownerId || session.projectId !== projectId) {
      sessionMismatch();
    }

    const requestedPaths = normalizePaths(paths);
    if (requestedPaths.some((requested) => !session.paths.includes(requested))) {
      scopeMismatch();
    }
    return snapshot(session);
  }

  end(id: string, ownerId: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      handoffRequired();
    }
    if (session.ownerId !== ownerId) {
      sessionMismatch();
    }
    session.state = 'closed';
  }

  pause(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.state === 'closed') {
      // Disconnect/end already revoked access; failure recording must still finish.
      return;
    }
    session.state = 'paused';
  }

  disconnect(ownerId: string): void {
    for (const session of this.sessions.values()) {
      if (session.ownerId === ownerId) {
        session.state = 'closed';
      }
    }
  }
}
