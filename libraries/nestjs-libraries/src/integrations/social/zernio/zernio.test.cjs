// Run with Node's built-in test runner. TypeScript and the small runtime dependencies
// are already in package.json; no application, database, Temporal server or network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const temporal = require('@temporalio/common');
const { validateSync } = require('class-validator');
const { plainToInstance } = require('class-transformer');
require('reflect-metadata');

const root = path.resolve(__dirname, '../../../../../..');
const providerPath = path.join(__dirname, 'zernio.provider.ts');
const workflowPath = path.join(
  root,
  'apps/orchestrator/src/workflows/post-workflows/post.workflow.v1.1.2.ts'
);
const callbackPath = path.join(
  root,
  'apps/frontend/src/app/(app)/integrations/social/zernio/page.tsx'
);
const controllerPath = path.join(
  root,
  'apps/backend/src/api/routes/no.auth.integrations.controller.ts'
);
const aliases = {
  '@gitroom/nestjs-libraries/': 'libraries/nestjs-libraries/src/',
  '@gitroom/helpers/': 'libraries/helpers/src/',
};
const noop = () => () => {};

// Transpile the real production modules; replace only infrastructure boundaries.
// This keeps focused tests runnable without installing Postiz's entire workspace.
function loadRuntime(extra = {}) {
  const cache = new Map();
  const stubs = {
    '@prisma/client': {},
    '@temporalio/activity': { ApplicationFailure: temporal.ApplicationFailure },
    '@gitroom/nestjs-libraries/temporal/temporal.heartbeat': {
      setHeartbeatDetails() {},
    },
    '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher': {
      getSsrfSafeDispatcher: () => ({ mocked: true }),
    },
    '@gitroom/helpers/utils/timer': {
      timer: async () => assert.fail('Unexpected transport retry/sleep'),
    },
    sharp: () => assert.fail('No media fetching/conversion in mocked tests'),
    ...extra,
  };
  function load(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const source = fs.readFileSync(filename, 'utf8');
    const { outputText, diagnostics } = ts.transpileModule(source, {
      fileName: filename,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        esModuleInterop: true,
      },
    });
    assert.equal(diagnostics?.length || 0, 0, filename);
    const module = { exports: {} };
    cache.set(filename, module);
    const localRequire = (name) => {
      if (Object.hasOwn(stubs, name)) return stubs[name];
      let resolved;
      for (const [prefix, directory] of Object.entries(aliases)) {
        if (name.startsWith(prefix))
          resolved = path.join(root, directory, name.slice(prefix.length));
      }
      if (name.startsWith('.'))
        resolved = path.resolve(path.dirname(filename), name);
      for (const [prefix, directory] of Object.entries(aliases)) {
        for (const [stubName, value] of Object.entries(stubs)) {
          if (
            stubName.startsWith(prefix) &&
            resolved ===
              path.join(root, directory, stubName.slice(prefix.length))
          )
            return value;
        }
      }
      if (resolved)
        return load(
          fs.existsSync(resolved + '.ts') ? resolved + '.ts' : resolved + '.tsx'
        );
      return require(name);
    };
    new Function('require', 'module', 'exports', outputText)(
      localRequire,
      module,
      module.exports
    );
    return module.exports;
  }
  return { load, provider: new (load(providerPath).ZernioProvider)() };
}

const profileId = 'a'.repeat(24),
  accountId = 'b'.repeat(24),
  vendorPostId = 'c'.repeat(24);
const key = 'mock-server-only-key';
const handoffId = '79c6dbf2-97ba-4f34-b615-5bf9435526db';
const identity = (platform = 'youtube') => ({ profileId, accountId, platform });
const internalId = (i) => `${i.profileId}:${i.platform}:${i.accountId}`;
const settings = (platform = 'youtube') =>
  platform === 'youtube'
    ? {
        platform,
        title: 'Mock video',
        visibility: 'public',
        madeForKids: false,
        containsSyntheticMedia: true,
      }
    : {
        platform,
        privacy_level: 'PUBLIC_TO_EVERYONE',
        allow_comment: true,
        allow_duet: false,
        allow_stitch: false,
        content_preview_confirmed: true,
        express_consent_given: true,
        commercialContentType: 'none',
        video_made_with_ai: true,
      };
const post = (platform = 'youtube') => ({
  id: 'local-post',
  message: 'Mock caption',
  settings: settings(platform),
  media: [{ type: 'video', path: 'https://media.example.test/video.mp4' }],
});
const result = (i, status = 'published') => ({
  post: {
    _id: vendorPostId,
    status,
    platforms: [
      {
        platform: i.platform,
        accountId: { _id: i.accountId },
        status,
        platformPostUrl: 'https://www.youtube.com/watch?v=mock-video',
        platformPostId: 'mock-video',
      },
    ],
  },
});
const response = (data, status = 200) =>
  new Response(JSON.stringify(data), { status });
const pending = (i) => ({ ...i, postId: vendorPostId });

function fixture(t, options = {}) {
  process.env.ZERNIO_API_KEY = key;
  process.env.FRONTEND_URL = 'https://postiz.example.test';
  const i = identity(options.platform);
  const calls = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    calls.push({ url, ...init });
    assert.equal(init.headers.Authorization, `Bearer ${key}`);
    assert.equal(init.redirect, 'error');
    assert.ok(!url.includes(key));
    const pathname = new URL(url).pathname;
    if (pathname.includes('/connect/handoffs/'))
      return response(
        options.handoff || {
          id: handoffId,
          status: 'connected',
          platform: i.platform,
          accounts: [{ id: accountId, profileId }],
        }
      );
    if (pathname.includes('/connect/'))
      return response({
        handoff: {
          id: handoffId,
          url: `https://zernio.com/connect/m/${handoffId}`,
        },
      });
    if (pathname.endsWith('/accounts'))
      return response({
        accounts: options.accounts || [
          {
            _id: accountId,
            profileId: { _id: profileId },
            platform: i.platform,
            isActive: true,
            displayName: 'Mock creator',
            username: 'mock-creator',
            accessToken: key,
          },
        ],
      });
    if (pathname.endsWith('/creator-info'))
      return response(
        options.creator || {
          creator: { nickname: 'Mock creator', canPostMore: true },
          commercialContentTypes: [
            { value: 'none', label: 'No commercial content' },
            { value: 'brand_organic', label: 'Your brand' },
            { value: 'brand_content', label: 'Paid partnership' },
          ],
          privacyLevels: [
            { value: 'PUBLIC_TO_EVERYONE', label: 'Public' },
            { value: 'SELF_ONLY', label: 'Only me' },
          ],
          postingLimits: {
            interactionSettings: {
              allow_comment: { enabled: true },
              allow_duet: { enabled: false },
              allow_stitch: { enabled: false },
            },
          },
          accessToken: key,
        }
      );
    if (init.method === 'POST') {
      if (options.submit) return options.submit(url, init);
      return response(options.created || result(i), options.httpStatus || 201);
    }
    if (pathname === `/api/v1/posts/${vendorPostId}`) {
      if (options.read) return options.read(url, init);
      return response(options.status || result(i));
    }
    assert.fail(`Unexpected mocked request ${pathname}`);
  });
  const runtime = loadRuntime(options.stubs);
  return {
    ...runtime,
    i,
    calls,
    submit: (p = post(i.platform), id = internalId(i)) =>
      runtime.provider.postPending(id, JSON.stringify(i), [p], {
        id: 'channel-1',
      }),
  };
}

test('hosted connection binds profile/platform/account, preserves state, never returns the key', async (t) => {
  const f = fixture(t);
  const url = `https://zernio.com/profiles/${profileId}?platform=youtube`;
  const client = { ...(await f.provider.externalUrl(url)), instanceUrl: url };
  const auth = await f.provider.generateAuthUrl(client);
  const query = new URL(f.calls[0].url).searchParams;
  assert.equal(query.get('handoff'), 'true');
  assert.equal(query.get('scopes'), 'posting');
  assert.equal(query.get('redirect_url'), null);
  assert.equal(new URL(auth.url).searchParams.get('state'), auth.state);
  assert.equal(
    new URL(auth.url).searchParams.get('connectUrl'),
    `https://zernio.com/connect/m/${handoffId}`
  );
  assert.equal(auth.state.length, 32);
  assert.ok(!JSON.stringify(auth).includes(key));
  const connected = await f.provider.authenticate({
    codeVerifier: auth.codeVerifier,
    code: 'complete',
  });
  assert.equal(connected.id, internalId(f.i));
  assert.deepEqual(JSON.parse(connected.accessToken), f.i);
  assert.match(connected.name, /youtube via Zernio/);
  assert.ok(!JSON.stringify(connected).includes(key));
  for (const callback of [
    { profileId: 'd'.repeat(24), accountId, connected: 'youtube' },
    { profileId, accountId, connected: 'tiktok' },
    { profileId, accountId, connected: 'youtube', error: 'denied' },
  ]) {
    await assert.rejects(
      f.provider.authenticate({
        codeVerifier: auth.codeVerifier,
        code: JSON.stringify(callback),
      }),
      /does not match/
    );
  }
  await assert.rejects(
    f.provider.authenticate({ codeVerifier: '', code: '{}' }),
    /Invalid Zernio/
  );
  await assert.rejects(
    f.provider.externalUrl(
      `https://evil.example/profiles/${profileId}?platform=youtube`
    )
  );
  await assert.rejects(
    f.provider.externalUrl(
      `https://zernio.com/profiles/${profileId}?platform=twitter`
    )
  );
});

test('handoff page delegates completion to the existing state controller, ignoring browser account IDs', async (t) => {
  const { load } = fixture(t, {
    stubs: {
      'react/jsx-runtime': {
        jsx: (component, props) => ({ component, props }),
      },
      'next/headers': {
        cookies: async () => ({ get: () => ({ name: 'auth' }) }),
      },
      '@gitroom/frontend/components/launches/continue.integration': {
        ContinueIntegration: 'ExistingContinueIntegration',
      },
    },
  });
  const page = await load(callbackPath).default({
    searchParams: Promise.resolve({
      state: 'original-state',
      complete: '1',
      profileId,
      accountId,
      connected: 'youtube',
      error: 'denied',
    }),
  });
  assert.equal(page.component, 'ExistingContinueIntegration');
  assert.equal(page.props.searchParams.state, 'original-state');
  assert.equal(page.props.searchParams.code, 'complete');
  assert.equal(page.props.searchParams.accountId, undefined);
});

test('YouTube video payload, disclosures, and idempotency use the existing post identity', async (t) => {
  const f = fixture(t);
  const [accepted] = await f.submit();
  const sent = f.calls.find((c) => c.method === 'POST');
  const payload = JSON.parse(sent.body);
  assert.equal(payload.publishNow, true);
  assert.equal(payload.scheduledFor, undefined);
  assert.deepEqual(payload.platforms[0], {
    platform: 'youtube',
    accountId,
    platformSpecificData: {
      title: 'Mock video',
      visibility: 'public',
      madeForKids: false,
      containsSyntheticMedia: true,
    },
  });
  assert.equal(accepted.status, 'pending');
  assert.equal(accepted.postId, vendorPostId);
  await f.submit();
  const creates = f.calls.filter((c) => c.method === 'POST');
  assert.equal(
    creates[0].headers['Idempotency-Key'],
    creates[1].headers['Idempotency-Key']
  );
  assert.ok(!JSON.stringify(accepted).includes(key));
  const mismatched = post();
  mismatched.settings.platform = 'tiktok';
  await assert.rejects(f.submit(mismatched), /settings do not match/);
  await assert.rejects(
    f.submit(post(), 'wrong-account'),
    /destination does not match/
  );
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 2);
});

test('forged callback cannot adopt an existing account without this hosted flow completing', async (t) => {
  const handoff = {
    id: handoffId,
    status: 'waiting',
    platform: 'youtube',
    accounts: [{ id: accountId, profileId }],
  };
  const f = fixture(t, { handoff });
  const codeVerifier = JSON.stringify({
    profileId,
    platform: 'youtube',
    handoffId,
  });
  await assert.rejects(
    f.provider.authenticate({ codeVerifier, code: 'complete' }),
    /incomplete or does not match/
  );
  handoff.status = 'connected';
  handoff.platform = 'tiktok';
  await assert.rejects(
    f.provider.authenticate({ codeVerifier, code: 'complete' }),
    /incomplete or does not match/
  );
  handoff.platform = 'youtube';
  handoff.accounts[0].profileId = 'd'.repeat(24);
  await assert.rejects(
    f.provider.authenticate({ codeVerifier, code: 'complete' }),
    /incomplete or does not match/
  );
  handoff.accounts[0].profileId = profileId;
  handoff.id = '00000000-0000-0000-0000-000000000000';
  await assert.rejects(
    f.provider.authenticate({ codeVerifier, code: 'complete' }),
    /incomplete or does not match/
  );
  assert.equal(
    f.calls.filter((c) => new URL(c.url).pathname.endsWith('/accounts')).length,
    0
  );
});

test('unsupported media, text-only, platform settings and threads never submit', async (t) => {
  const f = fixture(t);
  for (const media of [
    [],
    [{ type: 'image', path: 'https://media.example.test/p.png' }],
    [{ type: 'video', path: 'http://127.0.0.1/video.mp4' }],
    [...post().media, ...post().media],
  ]) {
    await assert.rejects(f.submit({ ...post(), media }));
  }
  await assert.rejects(
    f.provider.postPending(
      internalId(f.i),
      JSON.stringify(f.i),
      [post(), post()],
      { id: 'channel-1' }
    )
  );
  await assert.rejects(
    f.provider.post('', '', [], {}),
    /current Postiz pending-status workflow/
  );
  assert.equal(
    await f.provider.checkValidity(
      [[{ path: 'https://media.example.test/a.mp4' }]],
      settings()
    ),
    true
  );
  assert.notEqual(await f.provider.checkValidity([[]], settings()), true);
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 0);
});

test('native updateMedia shape uses its public URL and detects video despite type image', async (t) => {
  const f = fixture(t);
  await f.submit({
    ...post(),
    media: [
      {
        type: 'image',
        path: '/uploads/video.mp4',
        url: 'https://postiz.example.test/uploads/video.mp4',
      },
    ],
  });
  const body = JSON.parse(f.calls.find((c) => c.method === 'POST').body);
  assert.deepEqual(body.mediaItems, [
    { type: 'video', url: 'https://postiz.example.test/uploads/video.mp4' },
  ]);
});

test('TikTok uses current creator privacy/interactions and explicit preview/consent', async (t) => {
  const f = fixture(t, { platform: 'tiktok' });
  const account = await f.provider.accountSettings(
    JSON.stringify(f.i),
    'video',
    '',
    {}
  );
  assert.ok(!JSON.stringify(account).includes(key));
  await f.submit();
  const body = JSON.parse(f.calls.find((c) => c.method === 'POST').body);
  const videoSettings = body.platforms[0].platformSpecificData.tiktokSettings;
  assert.equal(videoSettings.content_preview_confirmed, true);
  assert.equal(videoSettings.express_consent_given, true);
  assert.equal(videoSettings.allow_comment, true);
  assert.equal(videoSettings.allow_duet, false);
  for (const invalid of [
    { content_preview_confirmed: false },
    { express_consent_given: false },
    { privacy_level: 'SELF_ONLY' },
    { privacy_level: 'not-an-option' },
    { allow_duet: true },
    { commercialContentType: undefined },
  ]) {
    const p = post('tiktok');
    Object.assign(p.settings, invalid);
    await assert.rejects(f.submit(p));
  }
  const photos = {
    ...post('tiktok'),
    media: [{ type: 'image', path: 'https://media.example.test/a.jpg' }],
  };
  photos.settings.video_made_with_ai = false;
  photos.settings.privacy_level = 'SELF_ONLY';
  await f.submit(photos);
  const photoBody = JSON.parse(
    f.calls.filter((c) => c.method === 'POST').at(-1).body
  );
  assert.equal(
    photoBody.platforms[0].platformSpecificData.tiktokSettings.media_type,
    'photo'
  );
  assert.equal(
    photoBody.platforms[0].platformSpecificData.tiktokSettings.allow_duet,
    undefined
  );
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 2);
});

test('DTO rejects missing/false consent and unsupported settings before scheduling', (t) => {
  const f = fixture(t);
  const { ZernioDto } = f.load(path.join(__dirname, 'zernio.dto.ts'));
  assert.equal(validateSync(plainToInstance(ZernioDto, settings())).length, 0);
  assert.equal(
    validateSync(plainToInstance(ZernioDto, settings('tiktok'))).length,
    0
  );
  for (const field of [
    'content_preview_confirmed',
    'express_consent_given',
    'commercialContentType',
  ]) {
    const s = settings('tiktok');
    delete s[field];
    assert.ok(
      validateSync(plainToInstance(ZernioDto, s)).some(
        (e) => e.property === field
      )
    );
  }
  assert.ok(
    validateSync(
      plainToInstance(ZernioDto, {
        ...settings('tiktok'),
        express_consent_given: false,
      })
    ).length
  );
});

test('status checks require the exact account and terminal per-platform status; early URLs stay pending', async (t) => {
  const early = result(identity(), 'scheduled');
  early.post.platforms[0].status = 'published';
  early.post.scheduledFor = '2999-01-01T00:00:00Z';
  const f = fixture(t, { status: early });
  assert.equal(
    (await f.provider.checkPostStatus(JSON.stringify(f.i), pending(f.i)))
      .status,
    'pending'
  );
  early.post.status = 'published';
  assert.equal(
    (await f.provider.checkPostStatus(JSON.stringify(f.i), pending(f.i)))
      .status,
    'pending'
  );
  delete early.post.scheduledFor;
  assert.deepEqual(
    await f.provider.checkPostStatus(JSON.stringify(f.i), pending(f.i)),
    {
      status: 'completed',
      postId: vendorPostId,
      releaseURL: 'https://www.youtube.com/watch?v=mock-video',
    }
  );
  early.post.platforms[0].accountId._id = 'd'.repeat(24);
  await assert.rejects(
    f.provider.checkPostStatus(JSON.stringify(f.i), pending(f.i)),
    /no matching/
  );
  await assert.rejects(
    f.provider.checkPostStatus(JSON.stringify(f.i), {
      ...pending(f.i),
      accountId: 'd'.repeat(24),
    }),
    /does not match/
  );
});

async function runWorkflow(t, options = {}) {
  const mutations = [],
    changes = [],
    updates = [],
    notifications = [];
  let checks = 0;
  let f;
  const wrap =
    (fn) =>
    async (...args) => {
      try {
        return await fn(...args);
      } catch (error) {
        throw new temporal.ActivityFailure(
          'Mock activity failed',
          'provider',
          '1',
          temporal.RetryState.NON_RETRYABLE_FAILURE,
          'mock-worker',
          error
        );
      }
    };
  const activities = {
    getPost: async () => ({ id: 'local-post', state: 'QUEUE' }),
    getPostsList: async () => [
      {
        id: 'local-post',
        organizationId: 'org',
        settings: '{}',
        integration: {
          id: 'channel-1',
          organizationId: 'org',
          providerIdentifier: 'zernio',
          name: 'Mock creator',
        },
      },
    ],
    postSocialPending: wrap(async () => {
      mutations.push('submit');
      const submitted = await f.submit();
      if (
        options.lostHeartbeat &&
        mutations.filter((m) => m === 'submit').length === 1
      )
        throw new temporal.TimeoutFailure(
          'Mock worker died before first heartbeat',
          undefined,
          temporal.TimeoutType.HEARTBEAT
        );
      return submitted;
    }),
    checkPostStatus: wrap(async () => {
      checks++;
      return f.provider.checkPostStatus(JSON.stringify(f.i), pending(f.i));
    }),
    changeState: async (...args) => {
      changes.push(args);
    },
    updatePost: async (...args) => {
      updates.push(args);
      if (options.updateFails) throw new Error('Mock DB failure');
    },
    inAppNotification: async (...args) => {
      notifications.push(args);
      if (options.notificationFails)
        throw new Error('Mock notification failure');
    },
    internalPlugs: async () => [],
    globalPlugs: async () => [],
    sendWebhooks: async () => {},
    finalizePost: () => assert.fail('Zernio must never finalize/re-submit'),
  };
  f = fixture(t, {
    ...options,
    stubs: {
      '@temporalio/workflow': {
        ...temporal,
        defineSignal: () => ({}),
        setHandler() {},
        sleep: async () => {},
        proxyActivities: (config) => {
          if (
            config.startToCloseTimeout === '30 minute' &&
            config.retry.maximumAttempts === 1
          )
            mutations.push('single-attempt-policy');
          return activities;
        },
      },
    },
  });
  const workflow = f.load(workflowPath).postWorkflowV112;
  await workflow({
    taskQueue: 'mock-queue',
    postId: 'local-post',
    organizationId: 'org',
    postNow: true,
  });
  return { f, mutations, changes, updates, notifications, checks };
}

test('actual V112 workflow: HTTP 207 partial failure is ERROR, never successful or resubmitted', async (t) => {
  const partial = result(identity(), 'partial');
  partial.post.platforms[0].status = 'failed';
  const r = await runWorkflow(t, {
    httpStatus: 207,
    created: partial,
    status: partial,
  });
  assert.equal(r.f.calls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(r.updates.length, 0);
  assert.equal(r.changes.at(-1)[1], 'ERROR');
  assert.ok(r.mutations.includes('single-attempt-policy'));
});

test('actual V112 workflow: accepted/pending status exhausts existing bound without publishing twice', async (t) => {
  const r = await runWorkflow(t, {
    httpStatus: 202,
    created: { postId: vendorPostId },
    status: result(identity(), 'scheduled'),
  });
  assert.equal(r.f.calls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(r.checks, 90);
  assert.equal(r.updates.length, 0);
  assert.equal(r.changes.at(-1)[1], 'ERROR');
  assert.match(r.notifications.at(-1)[2], /avoid duplicates/);
});

test('actual V112 workflow: ambiguous create/5xx cannot trigger shared transport or workflow retries', async (t) => {
  const r = await runWorkflow(t, {
    submit: async () => {
      throw new Error(`mock lost response ${key}`);
    },
  });
  assert.equal(r.f.calls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(r.changes.at(-1)[1], 'ERROR');
  assert.equal(r.updates.length, 0);
  assert.ok(!JSON.stringify(r.changes).includes(key));
  const failure = r.changes.at(-1)[2].cause;
  assert.equal(failure.type, 'bad_body');
  assert.equal(failure.nonRetryable, true);
});

test('actual V112 workflow: no-heartbeat retry after an effect reuses the idempotency key', async (t) => {
  const created = new Set();
  let effects = 0;
  const r = await runWorkflow(t, {
    lostHeartbeat: true,
    submit: async (url, init) => {
      const idempotency = init.headers['Idempotency-Key'];
      if (!created.has(idempotency)) {
        effects++;
        created.add(idempotency);
      }
      return response(result(identity()), 201);
    },
  });
  assert.equal(r.f.calls.filter((c) => c.method === 'POST').length, 2);
  assert.equal(effects, 1);
  assert.equal(r.updates.length, 1);
  assert.equal(r.updates[0][1], vendorPostId);
});

test('actual V112 workflow: HTTP failure and malformed acceptance stop after one create', async (t) => {
  for (const status of [429, 500, 401, 409]) {
    const r = await runWorkflow(t, {
      submit: async () => response({ error: key }, status),
    });
    assert.equal(r.f.calls.filter((c) => c.method === 'POST').length, 1);
    assert.equal(r.updates.length, 0);
    assert.ok(!JSON.stringify(r.changes).includes(key));
  }
  const r = await runWorkflow(t, { submit: async () => response(null, 202) });
  assert.equal(r.f.calls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(r.updates.length, 0);
});

test('creator and account failures prevent the actual submission', async (t) => {
  const f = fixture(t, {
    accounts: [
      {
        _id: accountId,
        profileId: 'd'.repeat(24),
        platform: 'youtube',
        isActive: true,
      },
    ],
  });
  await assert.rejects(f.submit(), /intended Zernio/);
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 0);
  const f2 = fixture(t, {
    platform: 'tiktok',
    creator: { creator: { canPostMore: false }, privacyLevels: [] },
  });
  await assert.rejects(f2.submit(), /available creator privacy/);
  assert.equal(f2.calls.filter((c) => c.method === 'POST').length, 0);
});

test('composer clears consent after edits and exposes only creator privacy options', (t) => {
  const i = { id: 'channel-1' };
  const value = [
    {
      content: 'Mock caption',
      image: [{ path: 'https://media.example.test/video.mp4' }],
    },
  ];
  const form = {};
  const methods = {
    register: (name) => ({ name }),
    watch: (name) => form[name],
    setValue: (name, val) => {
      form[name] = val;
    },
  };
  const effects = [],
    previous = [];
  let cursor = 0;
  const data = {
    platform: 'tiktok',
    nickname: 'Mock creator',
    canPost: true,
    privacyLevels: [
      { value: 'PUBLIC_TO_EVERYONE', label: 'Public' },
      { value: 'SELF_ONLY', label: 'Only me' },
    ],
    interactions: {},
  };
  const f = fixture(t, {
    stubs: {
      react: {
        useEffect: (fn, deps) => {
          const position = cursor++;
          if (
            !previous[position] ||
            deps.some((d, index) => d !== previous[position][index])
          )
            effects.push(fn);
          previous[position] = deps;
        },
      },
      'react/jsx-runtime': {
        jsx: (type, props) => ({ type, props }),
        jsxs: (type, props) => ({ type, props }),
      },
      swr: () => ({ data }),
      '../high.order.provider': {
        PostComment: { COMMENT: 'comment' },
        withProvider: (params) => params,
      },
      '@gitroom/frontend/components/launches/helpers/use.values': {
        useSettings: () => methods,
      },
      '@gitroom/frontend/components/launches/helpers/use.integration': {
        useIntegration: () => ({ value, integration: i }),
      },
      '@gitroom/helpers/utils/custom.fetch': { useFetch: () => {} },
      '@gitroom/react/form/select': { Select: 'select' },
      '@gitroom/react/form/input': { Input: 'input' },
    },
  });
  const component = f.load(
    path.join(
      root,
      'apps/frontend/src/components/new-launch/providers/zernio/zernio.provider.tsx'
    )
  ).default;
  const render = () => {
    cursor = 0;
    const tree = component.SettingsComponent();
    effects.splice(0).forEach((fn) => fn());
    return tree;
  };
  render();
  render();
  form.content_preview_confirmed = form.express_consent_given = true;
  const tree = render();
  assert.equal(form.express_consent_given, true);
  assert.ok(!JSON.stringify(tree).includes('SELF_ONLY'));
  value[0].content = 'Edited mock caption';
  render();
  assert.equal(form.content_preview_confirmed, false);
  assert.equal(form.express_consent_given, false);
  form.content_preview_confirmed = form.express_consent_given = true;
  form.commercialContentType = 'brand_content';
  render();
  assert.equal(form.express_consent_given, false);
});

test('actual V112 workflow: read errors are bounded, and post-acceptance DB failure cannot repost', async (t) => {
  const r = await runWorkflow(t, {
    read: async () => {
      throw new Error('mock read failure');
    },
  });
  assert.equal(r.checks, 5);
  assert.equal(r.f.calls.filter((c) => c.method === 'POST').length, 1);
  const r2 = await runWorkflow(t, { updateFails: true });
  assert.equal(r2.updates.length, 1);
  assert.equal(r2.f.calls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(r2.changes.at(-1)[1], 'ERROR');
});

test('existing connect controller rejects expired/reused states and projects credentials out of response', async (t) => {
  const redis = new Map([
    [
      'login:state-1',
      JSON.stringify({ profileId, platform: 'youtube', handoffId }),
    ],
    ['organization:state-1', 'org'],
  ]);
  const decorators = Object.fromEntries(
    ['Body', 'Controller', 'Get', 'Param', 'Post', 'UseFilters'].map((k) => [
      k,
      noop,
    ])
  );
  const f = fixture(t, {
    stubs: {
      '@nestjs/common': {
        ...decorators,
        HttpException: class extends Error {},
      },
      '@nestjs/swagger': { ApiTags: noop },
      '@gitroom/nestjs-libraries/redis/redis.service': {
        ioRedis: {
          get: async (k) => redis.get(k),
          del: async (k) => redis.delete(k),
        },
      },
      '@gitroom/nestjs-libraries/integrations/integration.manager': {
        IntegrationManager: class {},
      },
      '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service':
        { IntegrationService: class {} },
      '@gitroom/nestjs-libraries/integrations/refresh.integration.service': {
        RefreshIntegrationService: class {},
      },
      '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service':
        { OrganizationService: class {} },
      '@gitroom/backend/services/auth/permissions/permissions.ability': {
        CheckPolicies: noop,
      },
      '@gitroom/backend/services/auth/permissions/permission.exception.class': {
        AuthorizationActions: { Create: 'create' },
        Sections: { CHANNEL: 'channel' },
      },
      '@gitroom/nestjs-libraries/integrations/integration.missing.scopes': {
        NotEnoughScopesFilter: class {},
      },
      '@gitroom/helpers/auth/auth.service': { AuthService: {} },
    },
  });
  let writes = 0;
  const service = {
    migrateIntegrationOnConnect: async () => {},
    createOrUpdateIntegration: async () => {
      writes++;
      return {
        id: 'channel-1',
        token: key,
        refreshToken: 'private',
        customInstanceDetails: 'private',
        name: 'Mock creator',
      };
    },
  };
  const Controller = f.load(controllerPath).NoAuthIntegrationsController;
  const controller = new Controller(
    {
      getAllowedSocialsIntegrations: () => ['zernio'],
      getSocialIntegration: () => f.provider,
    },
    service,
    { startRefreshWorkflow: async () => {} },
    { getOrgById: async () => ({ id: 'org' }) }
  );
  const body = {
    state: 'state-1',
    timezone: '0',
    code: 'complete',
  };
  await assert.rejects(
    controller.connectSocialMedia('zernio', { ...body, state: 'expired' }),
    /expired/
  );
  assert.equal(f.calls.length, 0);
  const connected = await controller.connectSocialMedia('zernio', body);
  assert.equal(connected.id, 'channel-1');
  assert.ok(!JSON.stringify(connected).includes(key));
  assert.equal(connected.token, undefined);
  await assert.rejects(
    controller.connectSocialMedia('zernio', body),
    /expired/
  );
  assert.equal(writes, 1);
});
