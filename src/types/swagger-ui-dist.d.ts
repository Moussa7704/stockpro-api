// swagger-ui-dist ne publie pas ses types : seule la fonction utilisée par docs/docs.routes.ts
declare module "swagger-ui-dist" {
  export function getAbsoluteFSPath(): string;
}
