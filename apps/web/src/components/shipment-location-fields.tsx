'use client';

import type { FormEvent, ReactNode } from 'react';

export function ShipmentLocationFields({
  countryId,
  zoneId,
  children,
}: {
  countryId: string;
  zoneId: string;
  children: ReactNode;
}) {
  function suggestZone(event: FormEvent<HTMLDivElement>) {
    const country = event.target;
    if (!(country instanceof HTMLSelectElement) || country.id !== countryId) return;

    const zone = event.currentTarget.querySelector<HTMLSelectElement>('select[data-shipment-zone]');
    if (!zone || zone.id !== zoneId || zone.value || !country.value) return;

    const matching = [...zone.querySelectorAll('optgroup')].find(
      (group) => group.dataset.country === country.value,
    );
    const options = matching?.querySelectorAll('option');
    if (options?.length === 1) zone.value = options[0]!.value;
  }

  // Capture first so tab-local draft persistence sees the suggestion in the same change.
  return (
    <div className="shipment-field-grid" onChangeCapture={suggestZone}>
      {children}
    </div>
  );
}
