/**
 * CSS loader registration for Node.js test environment
 * Uses the new register() API instead of deprecated --loader
 */

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./scripts/css-loader.mjs', pathToFileURL('./'));
