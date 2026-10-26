'use client';

import { useEffect } from 'react';
import useSWR from 'swr';
import { PostComment, withProvider } from '../high.order.provider';
import { ZernioDto } from '@gitroom/nestjs-libraries/integrations/social/zernio/zernio.dto';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { useIntegration } from '@gitroom/frontend/components/launches/helpers/use.integration';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Select } from '@gitroom/react/form/select';
import { Input } from '@gitroom/react/form/input';

const useZernioAccount = (mediaType: string) => {
  const { integration } = useIntegration();
  const fetch = useFetch();
  return useSWR(
    integration ? ['zernio-account', integration.id, mediaType] : null,
    async () => {
      const response = await fetch('/integrations/function', {
        method: 'POST',
        body: JSON.stringify({
          name: 'accountSettings',
          id: integration!.id,
          data: mediaType,
        }),
      });
      if (!response.ok)
        throw new Error('Could not load Zernio account settings.');
      return response.json();
    }
  );
};

const ZernioSettings = () => {
  const { register, setValue, watch } = useSettings();
  const { value, integration } = useIntegration();
  const video = value[0]?.image?.some((m) =>
    /\.(mp4|mov|avi|wmv|flv|3gp|webm)(?:\?|$)/i.test(m.path)
  );
  const { data, error } = useZernioAccount(video ? 'video' : 'photo');
  const platform = data?.platform;
  const content = JSON.stringify(value);
  const privacy = watch('privacy_level');
  const commercial = watch('commercialContentType');
  const interactions = ['allow_comment', 'allow_duet', 'allow_stitch']
    .map((k) => watch(k))
    .join();
  const ai = watch('video_made_with_ai');
  useEffect(() => {
    if (platform) setValue('platform', platform, { shouldValidate: true });
    for (const key of [
      'madeForKids',
      'containsSyntheticMedia',
      'allow_comment',
      'allow_duet',
      'allow_stitch',
      'video_made_with_ai',
    ]) {
      if (watch(key) === undefined) setValue(key, false);
    }
  }, [platform, setValue, watch]);
  // Consent belongs to the current account/content/settings preview, never an edited draft.
  useEffect(() => {
    setValue('content_preview_confirmed', false);
    setValue('express_consent_given', false);
  }, [
    content,
    integration?.id,
    privacy,
    commercial,
    interactions,
    ai,
    setValue,
  ]);

  const check = (name: string, label: string, disabled = false) => (
    <label className="flex gap-[10px] my-[8px]">
      <input type="checkbox" {...register(name)} disabled={disabled} />
      {label}
    </label>
  );
  if (error)
    return (
      <div>Could not load Zernio account settings. Reconnect or try again.</div>
    );
  if (!platform) return <div>Loading Zernio account settings…</div>;
  return (
    <div className="flex flex-col gap-[10px]">
      <input type="hidden" {...register('platform')} />
      {platform === 'youtube' ? (
        <>
          <Input label="Video title" {...register('title')} maxLength={100} />
          <Select label="Visibility" {...register('visibility')}>
            <option value="">Choose visibility</option>
            {['public', 'unlisted', 'private'].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
          {check('madeForKids', 'This video is made for kids')}
          {check(
            'containsSyntheticMedia',
            'Contains realistic synthetic media'
          )}
          <p>
            One video, including Shorts. Postiz submits at the scheduled time;
            processing may delay release. A private upload or a URL alone does
            not confirm public publication.
          </p>
        </>
      ) : (
        <>
          <p>
            Publishing to {data.nickname}. Review the post preview and selected
            media before consenting. Business direct videos publish publicly.
          </p>
          <Select label="Who can see this post?" {...register('privacy_level')}>
            <option value="">Choose creator privacy</option>
            {(data.privacyLevels || [])
              .filter((p: any) => !video || p.value === 'PUBLIC_TO_EVERYONE')
              .map((p: any) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
          </Select>
          {!data.canPost && (
            <p>This creator cannot post now. Posting will be rejected.</p>
          )}
          {(['allow_comment', 'allow_duet', 'allow_stitch'] as const).map(
            (k) => (
              <div key={k}>
                {check(
                  k,
                  k.replace('_', ' '),
                  !data.interactions?.[k] || (!video && k !== 'allow_comment')
                )}
              </div>
            )
          )}
          <Select
            label="Commercial content"
            {...register('commercialContentType')}
          >
            <option value="">Choose disclosure</option>
            {(data.commercialContentTypes || []).map((p: any) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
          {check('video_made_with_ai', 'AI-generated video')}
          {check(
            'content_preview_confirmed',
            'I reviewed the full content and media in the post preview.'
          )}
          {check(
            'express_consent_given',
            'I expressly consent to sending this post to TikTok at the scheduled time.'
          )}
        </>
      )}
    </div>
  );
};

export default withProvider({
  postComment: PostComment.COMMENT,
  comments: false,
  minimumCharacters: [],
  SettingsComponent: ZernioSettings,
  dto: ZernioDto,
  maximumCharacters: 2200,
});
