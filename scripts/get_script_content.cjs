const fs = require('fs');
const auth = JSON.parse(fs.readFileSync(`${process.env.USERPROFILE}\\.clasprc.json`, 'utf8')).tokens.default;
(async () => {
  const id = '1XT6q4QikR0dI19UQTPtNceccrC-r72PDCxN_2v_mztcwuAG9cWS2Dqu';
  const url = `https://script.googleapis.com/v1/projects/${id}/content`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${auth.access_token}` } });
  console.log(`${r.status} ${url}`);
  console.log((await r.text()).slice(0, 30000));
})().catch(e => { console.error(e.stack || e); process.exit(1); });
