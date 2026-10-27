/**
 * Compares two `major.minor.patch[-pre]` versions: negative when `a` is older. A
 * pre-release is older than its release; pre-release labels compare as text.
 */
export function compareVersions(a: string, b: string): number {
  const [coreA = '', preA] = splitVersion(a);
  const [coreB = '', preB] = splitVersion(b);
  const partsA = coreA.split('.').map(Number);
  const partsB = coreB.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (partsA[index] ?? 0) - (partsB[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return preA < preB ? -1 : 1;
}

function splitVersion(version: string): [string, string | undefined] {
  const withoutBuild = version.split('+')[0] ?? version;
  const dash = withoutBuild.indexOf('-');
  return dash < 0
    ? [withoutBuild, undefined]
    : [withoutBuild.slice(0, dash), withoutBuild.slice(dash + 1)];
}
