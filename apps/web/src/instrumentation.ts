// Called once by Next.js when a server instance starts, before it handles requests.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { assertDevelopmentCodeSettingAllowed } = await import('./server/visitor.ts');
  // Refuses to start production with development sign-in codes switched on.
  assertDevelopmentCodeSettingAllowed({
    NEXT_PUBLIC_TRUCKER_STAGE: process.env.NEXT_PUBLIC_TRUCKER_STAGE,
    TRUCKER_STAGE: process.env['TRUCKER_STAGE'],
    TRUCKER_DEVELOPMENT_CODE_DISPLAY: process.env['TRUCKER_DEVELOPMENT_CODE_DISPLAY'],
  });
  const { stampArrivals } = await import('./server/arrival-stamp.ts');
  stampArrivals();
}
