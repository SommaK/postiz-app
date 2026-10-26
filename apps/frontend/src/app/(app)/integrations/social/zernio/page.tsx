import { ContinueIntegration } from '@gitroom/frontend/components/launches/continue.integration';
import { cookies } from 'next/headers';

export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const params = await searchParams;
  const auth = (await cookies()).get('auth');
  if (params.complete === '1')
    return (
      <ContinueIntegration
        provider="zernio"
        logged={!!auth?.name}
        searchParams={{ state: params.state || '', code: 'complete' }}
      />
    );
  let hosted: URL;
  try {
    hosted = new URL(params.connectUrl);
  } catch {
    return <p>Invalid Zernio connection. Start again from Add channel.</p>;
  }
  if (
    hosted.origin !== 'https://zernio.com' ||
    !/^\/connect\/m\/[a-f\d-]{36}$/i.test(hosted.pathname) ||
    hosted.username ||
    hosted.password
  )
    return <p>Invalid Zernio hosted connection.</p>;
  // Only the server's stored verifier selects the session/account at completion.
  const complete = new URLSearchParams({
    state: params.state || '',
    complete: '1',
  });
  return (
    <div className="flex flex-col gap-[20px] p-[24px]">
      <p>
        Connect your intended account in Zernio, then return to this tab and
        continue.
      </p>
      <a href={hosted.href} target="_blank" rel="noreferrer">
        Open Zernio connect
      </a>
      <a href={`?${complete}`}>I finished connecting — continue</a>
    </div>
  );
}
