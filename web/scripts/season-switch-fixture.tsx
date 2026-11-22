// Disposable rendered-source fixture. No installed API, credentials or media.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { TitleDetail } from '../src/components/title/title-detail';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '../src/app/fonts.css';
import '../src/app/globals.css';

const audit = { delay: 1200, fail: false, requests: [] as string[] };
Object.assign(window, { seasonAudit: audit });
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin);
  audit.requests.push(url.pathname + url.search);
  if (!url.pathname.startsWith('/api/')) throw new Error('Fixture permits API reads only');
  if (init?.method && init.method !== 'GET') throw new Error('Fixture forbids mutations');
  const season = Number(url.searchParams.get('s') ?? 1);
  const extras = url.pathname.endsWith('/extras');
  if (url.pathname.startsWith('/api/title/')) await new Promise(resolve => setTimeout(resolve, audit.delay));
  if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (audit.fail && url.pathname.startsWith('/api/title/')) return Response.json({message:'Season unavailable'}, {status:503});
  const seasons = [1,2,3].map(season => ({season,knownEpisodes:4,pack:null,transfer:null}));
  const payload = url.pathname.startsWith('/api/title/') ? extras ? {
    workKey:'audit:series',season,seasons,episodes:Array.from({length:4},(_,i)=>({episode:i+1,name:`Season ${season} episode ${i+1}`,airDate:'2020-01-01'})),
    genres:['Drama'],moreLikeThis:[],moreLikeThisSupported:false,
  } : {
    known:true,workKey:'audit:series',title:'Season switch verification',isSeries:true,mediaType:'series',year:2020,
    overview:'An isolated title-page fixture using the actual product components.',seasons,season,
    episodes:Array.from({length:4},(_,i)=>({season,episode:i+1,label:`S${season}E${i+1}`})),
  } : {};
  return Response.json(payload);
};
createRoot(document.getElementById('root')!).render(<BrowserRouter><TitleDetail workKey="audit:series" title="Season switch verification" mediaType="series" /></BrowserRouter>);
