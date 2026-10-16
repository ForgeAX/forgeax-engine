import type { UserConfig } from 'vite';

type ConfigFactory = (env: unknown) => UserConfig | Promise<UserConfig>;

export function defineConfig(config: UserConfig | ConfigFactory): UserConfig | ConfigFactory {
  return config;
}

export default defineConfig;
