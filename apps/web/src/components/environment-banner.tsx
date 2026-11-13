import type { Messages } from '../i18n/messages.ts';

// One persistent sign that this is not the live service. It is shown unless the build is
// explicitly marked as production; no production environment exists yet.
export function EnvironmentBanner({ messages }: { messages: Messages }) {
  if (process.env.NEXT_PUBLIC_TRUCKER_STAGE === 'production') return null;
  return (
    <div className="environment" role="note">
      <p>{messages.environment.development}</p>
    </div>
  );
}
