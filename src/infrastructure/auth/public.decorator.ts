import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC = "wws:isPublic";

/** Opts a controller or route out of the AuthGuard (health and metrics only). */
export const Public = (): ClassDecorator & MethodDecorator => SetMetadata(IS_PUBLIC, true);
