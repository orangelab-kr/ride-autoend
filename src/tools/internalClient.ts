import {
  DiscountPermission,
  FranchisePermission,
  InternalDiscountClient,
  InternalFranchiseClient,
  InternalKickboardClient,
  InternalLocationClient,
  InternalPlatformClient,
  InternalRideClient,
  KickboardPermission,
  LocationPermission,
  PlatformPermission,
  RidePermission,
} from 'openapi-internal-sdk';

export class InternalClient {
  public static getDiscount(
    permissions?: DiscountPermission[],
    email = 'system@hikick.kr'
  ): InternalDiscountClient {
    const client = new InternalDiscountClient({
      secretKey: process.env.HIKICK_OPENAPI_FRANCHISE_KEY || '',
      issuer: process.env.HIKICK_OPENAPI_ISSUER || '',
      permissions,
      email,
    });

    return client;
  }

  public static getKickboard(
    permissions?: KickboardPermission[],
    email = 'system@hikick.kr'
  ): InternalKickboardClient {
    const client = new InternalKickboardClient({
      secretKey: process.env.HIKICK_OPENAPI_FRANCHISE_KEY || '',
      issuer: process.env.HIKICK_OPENAPI_ISSUER || '',
      permissions,
      email,
    });

    return client;
  }

  public static getRide(
    permissions?: RidePermission[],
    email = 'system@hikick.kr'
  ): InternalRideClient {
    const client = new InternalRideClient({
      secretKey: process.env.HIKICK_OPENAPI_RIDE_KEY || '',
      issuer: process.env.HIKICK_OPENAPI_ISSUER || '',
      permissions,
      email,
    });

    return client;
  }

  public static getFranchise(
    permissions?: FranchisePermission[],
    email = 'system@hikick.kr'
  ): InternalFranchiseClient {
    const client = new InternalFranchiseClient({
      secretKey: process.env.HIKICK_OPENAPI_FRANCHISE_KEY || '',
      issuer: process.env.HIKICK_OPENAPI_ISSUER || '',
      permissions,
      email,
    });

    return client;
  }

  public static getPlatform(
    permissions?: PlatformPermission[],
    email = 'system@hikick.kr'
  ): InternalPlatformClient {
    const client = new InternalPlatformClient({
      secretKey: process.env.HIKICK_OPENAPI_PLATFORM_KEY || '',
      issuer: process.env.HIKICK_OPENAPI_ISSUER || '',
      permissions,
      email,
    });

    return client;
  }

  public static getLocation(
    permissions?: LocationPermission[],
    email = 'system@hikick.kr'
  ): InternalLocationClient {
    const client = new InternalLocationClient({
      secretKey: process.env.HIKICK_OPENAPI_LOCATION_KEY || '',
      issuer: process.env.HIKICK_OPENAPI_ISSUER || '',
      permissions,
      email,
    });

    return client;
  }
}
