/**
 * Contraste entre deux couleurs #RRGGBB selon la formule WCAG 2 (de 1 à 21).
 * 4,5 est le minimum pour un texte courant lisible (niveau AA).
 */
export const MIN_TEXT_CONTRAST = 4.5;

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const [r, g, b] = channels.map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrastRatio(first: string, second: string): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}
