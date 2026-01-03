import jwt from "jsonwebtoken";

const secret = process.env.JWT_SECRET || "dev_secret";

export function signToken(userId: string) {
  return jwt.sign({ userId }, secret, { expiresIn: "30d" });
}

export function verifyToken(token: string): { userId: string } {
  return jwt.verify(token, secret) as any;
}
