import { createHash } from 'crypto';
import { Integration } from '@prisma/client';
import { BadBody, SocialAbstract } from '../../social.abstract';
import {
  AuthTokenDetails,
  ClientInformation,
  PendingCheckResponse,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '../social.integrations.interface';
import { makeSecureId } from '../../../services/make.secure.id';
import { DashboardFunction } from '../../dashboard.function.decorator';
import { getSsrfSafeDispatcher } from '../../../dtos/webhooks/ssrf.safe.dispatcher';
import { ZernioDto } from './zernio.dto';
type Identity = {
  profileId: string;
  accountId: string;
  platform: 'youtube' | 'tiktok';
};
type Pending = Identity & { postId: string };
const objectId = /^[a-f\d]{24}$/i;
const videoPath = /\.(mp4|mov|avi|wmv|flv|3gp|webm)(?:\?|$)/i;
export class ZernioProvider extends SocialAbstract implements SocialProvider {
  identifier = 'zernio';
  name = 'Zernio';
  editor = 'normal' as const;
  dto = ZernioDto;
  scopes: string[] = [];
  isBetweenSteps = false;
  toolTip =
    'YouTube / TikTok. Enter https://zernio.com/profiles/PROFILE_ID?platform=youtube (or tiktok). Check the whole team has room in its two free accounts before connecting.';
  maxLength() {
    return 2200;
  }
  override async checkValidity(
    posts: Array<{ path: string }[]>,
    settings: ZernioDto
  ): Promise<string | true> {
    if (posts.length !== 1) return 'Zernio does not support threaded comments.';
    const media = posts[0];
    const videos = media.filter((m) => videoPath.test(m.path));
    if (
      !media.length ||
      (videos.length && media.length !== 1) ||
      media.length > 35 ||
      (settings.platform === 'youtube' && videos.length !== 1)
    )
      return 'Use one YouTube/TikTok video or up to 35 TikTok photos.';
    return true;
  }

  private fail(message: string, postId?: string): never {
    throw new BadBody(
      this.identifier,
      JSON.stringify({ postId }),
      '{}',
      message
    );
  }

  // Deliberately bypass SocialAbstract.fetch: it retries POSTs on 429/500.
  // Never include vendor bodies, request headers or transport errors in failures.
  private async request(path: string, body?: unknown, key?: string) {
    try {
      if (!process.env.ZERNIO_API_KEY) throw new Error();
      const response = await fetch(`https://zernio.com/api/v1/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${process.env.ZERNIO_API_KEY}`,
          'Content-Type': 'application/json',
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(90_000),
        dispatcher: getSsrfSafeDispatcher(),
      } as RequestInit);
      if (!response.ok) throw new Error();
      return { status: response.status, data: await response.json() };
    } catch {
      if (body !== undefined) {
        this.fail(
          'Zernio submission could not be confirmed. Check Zernio and the account before posting again to avoid duplicates.'
        );
      }
      throw new Error(
        'Zernio read failed; check the server configuration or reconnect.'
      );
    }
  }

  async externalUrl(url: string) {
    const parsed = new URL(url);
    const profileId = parsed.pathname.split('/')[2];
    const platform = parsed.searchParams.get('platform');
    if (
      parsed.origin !== 'https://zernio.com' ||
      parsed.pathname !== `/profiles/${profileId}` ||
      !objectId.test(profileId || '') ||
      !['youtube', 'tiktok'].includes(platform || '')
    ) {
      this.fail(
        'Use https://zernio.com/profiles/PROFILE_ID?platform=youtube (or tiktok).'
      );
    }
    return { client_id: profileId, client_secret: platform! };
  }

  async generateAuthUrl(client?: ClientInformation) {
    if (!client?.instanceUrl)
      this.fail('Choose a Zernio profile and platform first.');
    const { client_id: profileId, client_secret: platform } =
      await this.externalUrl(client.instanceUrl);
    const state = makeSecureId(32);
    const query = new URLSearchParams({
      profileId,
      handoff: 'true',
      scopes: 'posting',
    });
    const { data } = await this.request(`connect/${platform}?${query}`);
    const handoffId = data?.handoff?.id;
    let hosted: URL;
    try {
      hosted = new URL(data.handoff.url);
    } catch {
      this.fail('Zernio did not return a hosted connection handoff.');
    }
    if (
      hosted.origin !== 'https://zernio.com' ||
      hosted.username ||
      hosted.password ||
      hosted.pathname !== `/connect/m/${handoffId}` ||
      !/^[a-f\d-]{36}$/i.test(handoffId) ||
      hosted.href.includes(process.env.ZERNIO_API_KEY!)
    ) {
      this.fail('Zernio did not return a safe hosted connect link.');
    }
    const callback = new URL(
      `${process.env.FRONTEND_URL}/integrations/social/zernio`
    );
    callback.searchParams.set('state', state);
    callback.searchParams.set('connectUrl', hosted.href);
    // Postiz stores this verifier server-side against its one-use organization state.
    return {
      url: callback.href,
      state,
      codeVerifier: JSON.stringify({ profileId, platform, handoffId }),
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
  }): Promise<AuthTokenDetails> {
    let expected: any;
    try {
      expected = JSON.parse(params.codeVerifier);
    } catch {
      this.fail('Invalid Zernio connection state.');
    }
    const { profileId, platform, handoffId } = expected;
    if (
      !objectId.test(profileId || '') ||
      !['youtube', 'tiktok'].includes(platform) ||
      !/^[a-f\d-]{36}$/i.test(handoffId || '') ||
      params.code !== 'complete'
    ) {
      this.fail('Zernio account does not match this connection.');
    }
    // Browser callback IDs are not proof of OAuth. Read the outcome of this exact
    // hosted session with the private server key before attaching any account.
    const { data } = await this.request(`connect/handoffs/${handoffId}`);
    const connected = data.accounts?.[0];
    if (
      data.id !== handoffId ||
      data.status !== 'connected' ||
      data.platform !== platform ||
      data.accounts?.length !== 1 ||
      connected?.profileId !== profileId ||
      !objectId.test(connected?.id || '')
    ) {
      this.fail(
        'Zernio connection is incomplete or does not match. Restart and finish the hosted connection first.'
      );
    }
    const identity: Identity = {
      profileId,
      platform,
      accountId: connected.id,
    };
    const account = await this.account(identity);
    return {
      id: `${identity.profileId}:${identity.platform}:${identity.accountId}`,
      name: `${account.displayName || account.username} (${
        identity.platform
      } via Zernio)`,
      username: account.username || identity.accountId,
      // Only identity is persisted here. The API key stays in the server environment.
      accessToken: JSON.stringify(identity),
    };
  }

  async refreshToken(): Promise<AuthTokenDetails> {
    this.fail('Reconnect Zernio through its hosted connect screen.');
  }

  private identity(token: string): Identity {
    try {
      const value = JSON.parse(token);
      if (
        objectId.test(value.profileId) &&
        objectId.test(value.accountId) &&
        ['youtube', 'tiktok'].includes(value.platform)
      )
        return value;
    } catch {
      /* invalid stored identity */
    }
    this.fail('Invalid Zernio account identity; reconnect.');
  }

  private async account(identity: Identity) {
    const query = new URLSearchParams({
      profileId: identity.profileId,
      platform: identity.platform,
      search: identity.accountId,
    });
    const { data } = await this.request(`accounts?${query}`);
    const account = data.accounts?.find(
      (a: any) =>
        a._id === identity.accountId &&
        (a.profileId?._id || a.profileId) === identity.profileId &&
        a.platform === identity.platform &&
        a.isActive === true
    );
    if (!account)
      this.fail(
        'The intended Zernio profile/platform/account is disconnected or unavailable.'
      );
    return account;
  }

  @DashboardFunction()
  async accountSettings(token: string, data: unknown): Promise<any> {
    const identity = this.identity(token);
    await this.account(identity);
    if (identity.platform === 'youtube') return { platform: identity.platform };
    const { data: info } = await this.request(
      `accounts/${identity.accountId}/tiktok/creator-info?mediaType=${
        data === 'photo' ? 'photo' : 'video'
      }`
    );
    // Do not return the raw vendor account (it may contain credentials).
    return {
      platform: identity.platform,
      nickname: info.creator?.nickname,
      canPost: info.creator?.canPostMore === true,
      privacyLevels: (info.privacyLevels || []).map((p: any) => ({
        value: p.value,
        label: p.label,
      })),
      commercialContentTypes: (info.commercialContentTypes || []).map(
        (p: any) => ({ value: p.value, label: p.label })
      ),
      interactions: Object.fromEntries(
        ['allow_comment', 'allow_duet', 'allow_stitch'].map((k) => [
          k,
          info.postingLimits?.interactionSettings?.[k]?.enabled === true,
        ])
      ),
    };
  }

  private async payload(identity: Identity, post: PostDetails<ZernioDto>) {
    await this.account(identity);
    // updateMedia supplies both a worker-local path and a public URL, and labels
    // even videos as image. Follow existing providers' extension-based detection.
    const media = (post.media || []).map(
      (m: { type: 'image' | 'video'; path: string; url?: string }) => ({
        ...m,
        path: m.url || m.path,
        type: videoPath.test(m.url || m.path) ? 'video' : m.type,
      })
    );
    if (
      media.length === 0 ||
      media.some((m) => !['image', 'video'].includes(m.type))
    )
      this.fail('Choose supported image or video media.');
    const video = media.some((m) => m.type === 'video');
    if (
      (video && (media.length !== 1 || media[0].type !== 'video')) ||
      media.length > 35
    )
      this.fail('Use one video or at most 35 TikTok photos.');
    const mediaItems = media.map((m) => {
      const url = new URL(m.path);
      if (url.protocol !== 'https:' || url.username || url.password)
        this.fail(
          'Zernio requires publicly reachable HTTPS media from the Postiz media library.'
        );
      return { type: m.type, url: url.href };
    });
    const s = post.settings;
    if (s.platform !== identity.platform)
      this.fail('Post settings do not match the connected platform.');
    let platformSpecificData: any;
    if (identity.platform === 'youtube') {
      if (
        !video ||
        !s.title?.trim() ||
        s.title.length > 100 ||
        !['public', 'private', 'unlisted'].includes(s.visibility) ||
        typeof s.madeForKids !== 'boolean' ||
        typeof s.containsSyntheticMedia !== 'boolean'
      ) {
        this.fail(
          'YouTube requires one video, title, visibility, kids and synthetic-media choices.'
        );
      }
      platformSpecificData = {
        title: s.title,
        visibility: s.visibility,
        madeForKids: s.madeForKids,
        containsSyntheticMedia: s.containsSyntheticMedia,
      };
    } else {
      const info = await this.accountSettings(
        JSON.stringify(identity),
        video ? 'video' : 'photo'
      );
      if (
        !info.canPost ||
        !info.privacyLevels?.some((p: any) => p.value === s.privacy_level) ||
        (video && s.privacy_level !== 'PUBLIC_TO_EVERYONE')
      )
        this.fail(
          'Choose an available creator privacy option. TikTok Business direct videos must be public.'
        );
      if (
        s.content_preview_confirmed !== true ||
        s.express_consent_given !== true
      )
        this.fail(
          'Preview the TikTok content and give express consent before scheduling.'
        );
      for (const key of [
        'allow_comment',
        'allow_duet',
        'allow_stitch',
      ] as const) {
        if (
          typeof s[key] !== 'boolean' ||
          (s[key] && !info.interactions?.[key])
        )
          this.fail(
            'Choose only interactions permitted by this TikTok creator.'
          );
      }
      if (
        !info.commercialContentTypes?.some(
          (p: any) => p.value === s.commercialContentType
        ) ||
        (s.commercialContentType === 'brand_content' &&
          s.privacy_level === 'SELF_ONLY') ||
        typeof s.video_made_with_ai !== 'boolean' ||
        (!video && s.video_made_with_ai)
      )
        this.fail(
          'Choose commercial/AI disclosures. AI-labelled TikTok photos require the unsupported Creator Inbox flow.'
        );
      platformSpecificData = {
        tiktokSettings: {
          privacy_level: s.privacy_level,
          allow_comment: s.allow_comment,
          ...(video
            ? { allow_duet: s.allow_duet, allow_stitch: s.allow_stitch }
            : {}),
          content_preview_confirmed: s.content_preview_confirmed,
          express_consent_given: s.express_consent_given,
          commercialContentType: s.commercialContentType,
          video_made_with_ai: s.video_made_with_ai,
          media_type: video ? 'video' : 'photo',
        },
      };
    }
    return {
      content: post.message,
      mediaItems,
      platforms: [
        {
          platform: identity.platform,
          accountId: identity.accountId,
          platformSpecificData,
        },
      ],
      publishNow: true,
    };
  }

  // Postiz owns the schedule: submit only when its existing Temporal workflow is due.
  async postPending(
    id: string,
    token: string,
    posts: PostDetails<ZernioDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    if (posts.length !== 1)
      this.fail('Zernio supports one post, without threaded comments.');
    const identity = this.identity(token);
    if (
      id !== `${identity.profileId}:${identity.platform}:${identity.accountId}`
    )
      this.fail('Post destination does not match the connected account.');
    const post = posts[0];
    const body = await this.payload(identity, post);
    const key = createHash('sha256')
      .update(`postiz:zernio:${integration.id}:${post.id}`)
      .digest('hex');
    const { status, data } = await this.request('posts', body, key);
    const postId = data?.post?._id || data?.postId;
    if (!objectId.test(postId || ''))
      this.fail(
        'Zernio returned no post identity. Check the account before posting again.'
      );
    // Always resolve through the read-only status contract, including 207/202.
    return [
      {
        id: post.id,
        postId,
        releaseURL: '',
        status: 'pending',
        pendingData: { ...identity, postId, submissionStatus: status },
      },
    ];
  }

  async post(): Promise<PostResponse[]> {
    // Old blocking workflow versions cannot safely represent asynchronous acceptance.
    this.fail('Zernio requires the current Postiz pending-status workflow.');
  }

  override async checkPostStatus(
    token: string,
    pending: Pending
  ): Promise<PendingCheckResponse> {
    const identity = this.identity(token);
    if (
      pending.accountId !== identity.accountId ||
      pending.profileId !== identity.profileId ||
      pending.platform !== identity.platform ||
      !objectId.test(pending.postId)
    )
      this.fail('Zernio pending post does not match the connected account.');
    const { data } = await this.request(`posts/${pending.postId}`);
    const post = data.post;
    if (post?._id !== pending.postId)
      this.fail('Zernio returned a different post identity.', pending.postId);
    const target = post.platforms?.find(
      (p: any) =>
        p.platform === identity.platform &&
        (p.accountId?._id || p.accountId) === identity.accountId
    );
    if (!target)
      this.fail(
        'Zernio returned no matching platform/account status.',
        pending.postId
      );
    if (
      ['failed', 'cancelled'].includes(target.status) ||
      ['failed', 'cancelled', 'partial'].includes(post.status)
    ) {
      this.fail(
        `Zernio post ${pending.postId} failed, was cancelled or partially published. Inspect it before reposting.`,
        pending.postId
      );
    }
    // A URL from an early private YouTube upload alone does not mean published.
    if (
      post.status === 'published' &&
      target.status === 'published' &&
      target.platformPostUrl &&
      (!post.scheduledFor ||
        new Date(post.scheduledFor).getTime() <= Date.now())
    ) {
      const url = new URL(target.platformPostUrl);
      if (url.protocol !== 'https:')
        this.fail('Zernio returned an invalid post URL.', pending.postId);
      return {
        status: 'completed',
        postId: pending.postId,
        releaseURL: url.href,
      };
    }
    return { status: 'pending', pendingData: pending };
  }
}
