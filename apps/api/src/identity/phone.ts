/**
 * International mobile numbers in E.164 form: "+", a country code that does not start with 0,
 * and 7 to 15 digits in total. Spaces, hyphens, dots and brackets typed by a person are
 * removed; a leading "00" is read as "+". Nothing else is guessed: a number without a country
 * code is refused, because the country cannot be assumed.
 *
 * This checks the shape only. Whether the number exists is proven by the one-time code.
 */
const E164 = /^\+[1-9][0-9]{6,14}$/;

export function normalizePhone(input: string): string | null {
  // Left-to-right marks and similar invisible characters appear when a number is copied from
  // right-to-left text.
  let value = input.replace(/[\s\-.()‎‏‪-‮⁦-⁩]/g, '');
  // Arabic-Indic and Extended Arabic-Indic digits are accepted and stored as ASCII digits.
  value = value.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  value = value.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  return E164.test(value) ? value : null;
}

/** For display: the number with all but the country-code start and the last two digits hidden. */
export function maskPhone(e164: string): string {
  return `${e164.slice(0, 4)}${'•'.repeat(Math.max(0, e164.length - 6))}${e164.slice(-2)}`;
}
