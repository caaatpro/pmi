import { join } from 'node:path';

export function getGlobalConfigTomlPath(homeDir: string): string {
  return join(homeDir, '.baton', 'config.toml');
}

export function getProjectConfigTomlPath(projectRoot: string): string {
  return join(projectRoot, 'baton.toml');
}

export function getGlobalYamlPath(homeDir: string): string {
  return join(homeDir, '.baton', 'baton.yml');
}

export function getProjectYamlPath(projectRoot: string): string {
  return join(projectRoot, 'baton.yml');
}

export function getGlobalDotenvPath(homeDir: string): string {
  return join(homeDir, '.baton', '.env');
}

export function getProjectDotenvPath(projectRoot: string): string {
  return join(projectRoot, '.env');
}

export function getLegacyConfigJsonPath(homeDir: string): string {
  return join(homeDir, '.baton', 'config.json');
}
