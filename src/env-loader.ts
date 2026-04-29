/**
 * env-loader.ts
 * Loaded via tsx --import before any other module.
 * Uses override:true so .env values win over empty shell-exported vars.
 */
import dotenv from 'dotenv';
dotenv.config({ override: true });
