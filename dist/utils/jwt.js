"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signToken = signToken;
exports.verifyToken = verifyToken;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const secret = process.env.JWT_SECRET || "dev_secret";
function signToken(userId, tokenVersion) {
    return jsonwebtoken_1.default.sign({ userId, tv: tokenVersion }, secret, { expiresIn: "30d" });
}
function verifyToken(token) {
    return jsonwebtoken_1.default.verify(token, secret);
}
