import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name} — copy .env.example to .env and fill it in`);
  return value;
}

export const STEAM = {
  username: required("STEAM_USERNAME"),
  password: required("STEAM_PASSWORD"),
  sharedSecret: required("STEAM_SHARED_SECRET"),
  identitySecret: required("STEAM_IDENTITY_SECRET"),
  proxy: process.env.STEAM_PROXY || undefined,
};
