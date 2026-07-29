export {
  createPlatform,
  type Platform,
  type PlatformComposition,
  type PlatformOverrides,
  type PlatformRepositories,
} from "./composition-root.js";

export { PLATFORM_PERMISSIONS, type PermissionRule } from "./authorization/permissions.js";
export {
  authorizePlatform,
  ForbiddenError,
  isForbiddenThrown,
  type AuthorizePlatformDeps,
} from "./authorization/authorize-platform.js";
