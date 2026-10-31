import pkg from '../../package.json';

export function getCliVersion(): string {
  return typeof __BATON_VERSION__ !== 'undefined'
    ? __BATON_VERSION__
    : pkg.version;
}
