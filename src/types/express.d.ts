import "express";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role: "BUYER" | "SELLER" | "SUPER_ADMIN";
        fullName: string;
        email: string;
        tip?: string | null;
        categoryId?: string | null;
      };
    }
  }
}

export {};
