import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors.js';
import { SessionManager } from '../../src/changes/sessions.js';
import { WRITE_LIMITS, type Attestation } from '../../src/changes/types.js';

const attestation: Attestation = {
  source: 'user-message',
  statement: 'I saved and closed all editor pages for this project.'
};

function expectAppError(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`Expected AppError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
  }
}

describe('SessionManager', () => {
  it('creates a user-attested session with an exact path scope', () => {
    const manager = new SessionManager(() => 1000);
    const session = manager.begin(
      'owner-a',
      'project-a',
      attestation,
      ['scene/start.txt', 'game/config.txt'],
      5000
    );

    expect(session).toMatchObject({
      ownerId: 'owner-a',
      projectId: 'project-a',
      paths: ['scene/start.txt', 'game/config.txt'],
      createdAt: 1000,
      expiresAt: 6000,
      state: 'active',
      userAttested: true,
      automaticDirtyCheck: false
    });
    expect(manager.require(
      session.id,
      'owner-a',
      'project-a',
      ['scene/start.txt']
    )).toMatchObject({ id: session.id, state: 'active' });
  });

  it('does not expose mutable session state or paths', () => {
    const manager = new SessionManager(() => 1000);
    const session = manager.begin(
      'owner',
      'project',
      attestation,
      ['scene/start.txt']
    );

    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.paths)).toBe(true);
    expect(Object.isFrozen(session.attestation)).toBe(true);
    expect(session.attestation).toEqual(attestation);
    expect(() => session.paths.push('scene/other.txt')).toThrow(TypeError);
    expect(() => {
      (session as { state: string }).state = 'closed';
    }).toThrow(TypeError);

    expect(manager.require(
      session.id,
      'owner',
      'project',
      ['scene/start.txt']
    ).state).toBe('active');
  });

  it.each([
    ['boolean attestation', true],
    ['non-user source', { source: 'assistant', statement: 'saved' }],
    ['empty statement', { source: 'user-message', statement: '   ' }]
  ])('rejects %s as a handoff', (_label, value) => {
    const manager = new SessionManager(() => 1000);
    expectAppError(
      () => manager.begin(
        'owner',
        'project',
        value as unknown as Attestation,
        ['scene/start.txt']
      ),
      'HANDOFF_REQUIRED'
    );
  });

  it('rejects empty, invalid, wildcard, and oversized path scopes', () => {
    const manager = new SessionManager(() => 1000);
    expectAppError(() => manager.begin('owner', 'project', attestation, []), 'INVALID_ARGUMENT');
    for (const paths of [
      [''],
      ['../outside.txt'],
      ['scene/*.txt'],
      ['scene\\start.txt']
    ]) {
      expectAppError(
        () => manager.begin('owner', 'project', attestation, paths),
        paths[0] === '' ? 'INVALID_ARGUMENT' : 'PATH_INVALID'
      );
    }

    expectAppError(
      () => manager.begin(
        'owner',
        'project',
        attestation,
        Array.from({ length: WRITE_LIMITS.maxFiles + 1 }, (_, index) => `scene/${index}.txt`)
      ),
      'INVALID_ARGUMENT'
    );
  });

  it('enforces the maximum TTL and expires using the injected clock', () => {
    let now = 100;
    const manager = new SessionManager(() => now);

    expectAppError(
      () => manager.begin(
        'owner',
        'project',
        attestation,
        ['scene/start.txt'],
        WRITE_LIMITS.maxSessionTtlMs + 1
      ),
      'INVALID_ARGUMENT'
    );
    expectAppError(
      () => manager.begin(
        'owner',
        'project',
        attestation,
        ['scene/start.txt'],
        0
      ),
      'INVALID_ARGUMENT'
    );

    const session = manager.begin(
      'owner',
      'project',
      attestation,
      ['scene/start.txt'],
      5
    );
    now = 104;
    expect(manager.require(session.id, 'owner', 'project', ['scene/start.txt']).state)
      .toBe('active');
    now = 105;
    expectAppError(
      () => manager.require(session.id, 'owner', 'project', ['scene/start.txt']),
      'SESSION_EXPIRED'
    );
  });

  it('rejects the wrong owner, project, and out-of-scope paths', () => {
    const manager = new SessionManager(() => 1000);
    const session = manager.begin(
      'owner',
      'project',
      attestation,
      ['scene/start.txt']
    );

    expectAppError(
      () => manager.require(session.id, 'other-owner', 'project', ['scene/start.txt']),
      'SESSION_MISMATCH'
    );
    expectAppError(
      () => manager.require(session.id, 'owner', 'other-project', ['scene/start.txt']),
      'SESSION_MISMATCH'
    );
    expectAppError(
      () => manager.require(session.id, 'owner', 'project', ['scene/other.txt']),
      'SCOPE_MISMATCH'
    );
    expectAppError(
      () => manager.require(session.id, 'owner', 'project', ['scene/START.txt']),
      'SCOPE_MISMATCH'
    );
  });

  it('invalidates sessions on end, pause, disconnect, and manager restart', () => {
    const manager = new SessionManager(() => 1000);
    const ended = manager.begin('owner', 'project', attestation, ['scene/a.txt']);
    manager.end(ended.id, 'owner');
    expectAppError(
      () => manager.require(ended.id, 'owner', 'project', ['scene/a.txt']),
      'HANDOFF_REQUIRED'
    );

    const paused = manager.begin('owner', 'project', attestation, ['scene/b.txt']);
    manager.pause(paused.id);
    expectAppError(
      () => manager.require(paused.id, 'owner', 'project', ['scene/b.txt']),
      'HANDOFF_REQUIRED'
    );

    const disconnected = manager.begin('owner', 'project', attestation, ['scene/c.txt']);
    const otherOwner = manager.begin('other', 'project', attestation, ['scene/d.txt']);
    manager.disconnect('owner');
    expectAppError(
      () => manager.require(disconnected.id, 'owner', 'project', ['scene/c.txt']),
      'HANDOFF_REQUIRED'
    );
    expect(manager.require(
      otherOwner.id,
      'other',
      'project',
      ['scene/d.txt']
    ).state).toBe('active');

    const restarted = new SessionManager(() => 1000);
    expectAppError(
      () => restarted.require(
        otherOwner.id,
        'other',
        'project',
        ['scene/d.txt']
      ),
      'HANDOFF_REQUIRED'
    );
  });

  it('rejects ending a session with the wrong owner', () => {
    const manager = new SessionManager(() => 1000);
    const session = manager.begin('owner', 'project', attestation, ['scene/a.txt']);
    expectAppError(() => manager.end(session.id, 'other'), 'SESSION_MISMATCH');
  });
});
