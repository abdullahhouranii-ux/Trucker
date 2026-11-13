import { notFound } from 'next/navigation';

// Any address that no page claims, under a known language, is answered with the not-found page.
export const dynamic = 'force-dynamic';

export default function CatchAll() {
  notFound();
}
