import jwt from "jsonwebtoken";

const secret = process.env.JWT_SECRET || "dev_secret";

export function signToken(userId: string, tokenVersion: number) {
  return jwt.sign({ userId, tv: tokenVersion }, secret, { expiresIn: "30d" });
}

export function verifyToken(token: string): { userId: string; tv: number } {
  return jwt.verify(token, secret) as any;
}
