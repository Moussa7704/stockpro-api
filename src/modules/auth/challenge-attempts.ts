import { AppError } from "../../utils/app-error.js";
import type { TwoFactorChallenge } from "../../utils/jwt.js";

/**
 * Suivi des challenges 2FA en mémoire :
 * - 5 codes faux maximum par challenge, ensuite il faut refaire le login (mot de passe)
 * - un challenge réussi ne peut pas resservir
 * Sans cette limite, on pourrait tester les 1 000 000 de codes possibles avec un seul challenge.
 *
 * Limite connue : en mémoire = propre à un processus. Avec plusieurs instances de l'API,
 * il faudra un stockage partagé (Redis ou table PostgreSQL).
 */

const MAX_FAILED_ATTEMPTS = 5;

interface ChallengeState {
  failures: number;
  used: boolean;
  expiresAt: number; // ms
}

const challenges = new Map<string, ChallengeState>();

// On oublie les challenges expirés (un JWT expiré est de toute façon refusé)
function purgeExpired(now: number): void {
  for (const [jti, state] of challenges) {
    if (state.expiresAt <= now) {
      challenges.delete(jti);
    }
  }
}

function getState(challenge: TwoFactorChallenge): ChallengeState {
  purgeExpired(Date.now());

  let state = challenges.get(challenge.jti);
  if (!state) {
    state = { failures: 0, used: false, expiresAt: challenge.exp * 1000 };
    challenges.set(challenge.jti, state);
  }
  return state;
}

export function assertChallengeUsable(challenge: TwoFactorChallenge): void {
  const state = getState(challenge);
  if (state.used) {
    throw AppError.unauthorized("Connexion expirée, reconnectez-vous");
  }
  if (state.failures >= MAX_FAILED_ATTEMPTS) {
    throw AppError.unauthorized("Trop de tentatives, reconnectez-vous");
  }
}

export function recordFailedAttempt(challenge: TwoFactorChallenge): void {
  getState(challenge).failures += 1;
}

export function markChallengeUsed(challenge: TwoFactorChallenge): void {
  getState(challenge).used = true;
}
