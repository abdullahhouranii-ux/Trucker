export const closureBlockerLabels: Record<string, string> = {
  settlement_hold: 'Active settlement hold',
  fee_unreconciled: 'Trucker fee pending reconciliation',
  refund_unreconciled: 'Refund pending reconciliation',
  missing_freight_terms: 'Booked freight terms unavailable',
  freight_unreconciled: 'Freight payment pending reconciliation',
  commission_unreconciled: 'Commission pending reconciliation',
  trip_not_dispatched: 'Trip pending dispatch',
  pod_not_accepted: 'Proof of delivery pending acceptance',
  resources_not_released: 'Resources still reserved or occupied',
  cargo_in_custody: 'Cargo still in vehicle custody',
  booking_cancelled: 'Booking cancelled',
};

export const financialNavigation = {
  en: {
    title: 'Booking financial records',
    empty: 'No booking financial records are available.',
    unavailable: 'The financial record is unavailable.',
  },
  ar: {
    title: 'السجلات المالية للحجوزات',
    empty: 'لا توجد سجلات مالية للحجوزات.',
    unavailable: 'السجل المالي غير متاح.',
  },
  ur: {
    title: 'بکنگ کے مالی ریکارڈ',
    empty: 'بکنگ کا کوئی مالی ریکارڈ دستیاب نہیں ہے۔',
    unavailable: 'مالی ریکارڈ دستیاب نہیں ہے۔',
  },
};
