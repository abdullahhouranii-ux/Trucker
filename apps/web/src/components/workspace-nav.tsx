'use client';

import { WorkspaceGroups, type WorkspaceGroup } from './workspace-groups.tsx';
import { usePathname } from 'next/navigation';
import type { Locale } from '../i18n/config.ts';

const labels = {
  en: {
    workspace: 'Workspace',
    shipping: 'Shipping',
    transport: 'Transport',
    management: 'Organisation',
    account: 'My account',
    organisations: 'My accounts',
    driver: 'My trips',
    overview: 'Overview',
    operations: 'Operations',
    shipments: 'Shipments',
    bookings: 'Bookings',
    discovery: 'Find shipments',
    quotations: 'Quotations',
    fleet: 'Fleet',
    authority: 'Authorities',
    contracts: 'Contracts',
    cargo: 'Cargo cases',
  },
  ar: {
    workspace: 'مساحة العمل',
    shipping: 'إدارة الشحنات',
    transport: 'عمليات النقل',
    management: 'إدارة المؤسسة',
    account: 'حسابي',
    organisations: 'حساباتي',
    driver: 'رحلاتي',
    overview: 'نظرة عامة',
    operations: 'لوحة العمليات',
    shipments: 'الشحنات',
    bookings: 'الحجوزات',
    discovery: 'البحث عن شحنات',
    quotations: 'العروض',
    fleet: 'الأسطول',
    authority: 'التفويضات',
    contracts: 'العقود',
    cargo: 'حالات البضاعة',
  },
  ur: {
    workspace: 'کام کی جگہ',
    shipping: 'شپمنٹس کا انتظام',
    transport: 'نقل و حمل',
    management: 'ادارے کا انتظام',
    account: 'میرا اکاؤنٹ',
    organisations: 'میرے اکاؤنٹس',
    driver: 'میرے سفر',
    overview: 'جائزہ',
    operations: 'آپریشنز',
    shipments: 'شپمنٹس',
    bookings: 'بکنگ',
    discovery: 'شپمنٹس تلاش کریں',
    quotations: 'پیشکشیں',
    fleet: 'گاڑیاں',
    authority: 'اختیارات',
    contracts: 'معاہدے',
    cargo: 'کارگو کے معاملات',
  },
};

// Navigation is not authorization. Every destination keeps its existing server-side checks.
export function WorkspaceNav({ locale }: { locale: Locale }) {
  const path = usePathname() ?? '';
  const m = labels[locale];
  const root = `/${locale}`;
  const match = /^\/(en|ar|ur)\/organisations\/([0-9a-f-]{36})(?:\/|$)/i.exec(path);
  const inWorkspace =
    match ||
    ['/account', '/organisations', '/driver', '/operations'].some(
      (part) => path === root + part || path.startsWith(root + part + '/'),
    );
  if (!inWorkspace) return null;
  const org = match ? `${root}/organisations/${match[2]}` : null;
  const groups: WorkspaceGroup[] = org
    ? [
        {
          links: [
            [org, m.overview],
            [org + '/operations', m.operations],
          ],
        },
        {
          label: m.shipping,
          links: [
            [`${org}/shipments`, m.shipments],
            [`${org}/quotations`, m.quotations],
            [`${org}/bookings`, m.bookings],
          ],
        },
        {
          label: m.transport,
          links: [
            [`${org}/discover`, m.discovery],
            [`${org}/fleet`, m.fleet],
            [`${org}/cargo-cases`, m.cargo],
          ],
        },
        {
          label: m.management,
          links: [
            [`${org}/authorities`, m.authority],
            [`${org}/contracts`, m.contracts],
          ],
        },
      ]
    : [
        {
          links: [
            [`${root}/operations`, m.operations],
            [`${root}/organisations`, m.organisations],
            [`${root}/driver`, m.driver],
            [`${root}/account`, m.account],
          ],
        },
      ];
  return (
    <nav className="workspace-nav workspace-rail" aria-label={m.workspace}>
      <a className="brand workspace-brand" href={root} lang="en">
        <span dir="ltr">Trucker</span>
      </a>
      <span className="workspace-label">{m.workspace}</span>
      <WorkspaceGroups
        groups={groups}
        idPrefix="participant-workspace"
        isCurrent={(href) => path === href || (href !== org && path.startsWith(href + '/'))}
      />
    </nav>
  );
}
