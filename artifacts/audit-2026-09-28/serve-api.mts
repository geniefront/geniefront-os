import {buildServer} from '../../apps/api/src/server.ts';
const app=buildServer();
await app.listen({host:'127.0.0.1',port:57210});
