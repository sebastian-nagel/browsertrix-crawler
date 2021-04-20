"use strict";

//const autoplayScript = require("/app/autoplay.js");

/* eslint-disable no-undef */

const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const warcio = require("warcio");

module.exports = async ({data, page, crawler}) => {
  const {url} = data;

  if (!crawler.params.statsFilename) {
    // put statistics file into collection folder
    crawler.params.statsFilename = path.join(crawler.collDir, "stats.json");
  }

  const captureList = path.join(crawler.collDir, "captures.jsonl");
  async function writeCapture({url, timestamp, isSeed, isHTML}) {
    //let row = {"url": url, "timestamp": timestamp, "isSeed": isSeed, "isHTML": isHTML}
    let row = {url, timestamp, isSeed, isHTML};
    let line = JSON.stringify(row).concat("\n");
    fs.appendFileSync(captureList, line);
  }

  // whether this is a seed (note: works only for single-seed crawls)
  let isSeed = crawler.seenList.size <= 1;

  if (!await crawler.isHTML(url)) {
    // for now skip over all non-HTML content (PDFs, videos, etc.)
    console.log(`Skip fetching non-HTML content ${url}`);
    // TODO: fetching would be:
    //       await crawler.directFetchCapture(url);
    // to avoid that we're inspecting non-HTML content again, mark it as visited
    await writeCapture({url, timestamp: null, isSeed, isHTML: false});
    return;
  }

  /* Sleep before fetching any further page (after the seed URL)
   * Note: timeout must include the max. sleep time */
  // base sleep time, multiplied by random number [.5, 1.5]
  const sleepTime = 60;
  if (!isSeed) {
    let s = Math.floor(1000 * (sleepTime / 2 + Math.random() * sleepTime));
    console.log(`Random sleep for ${s} ms, before capturing ${url}`);
    await crawler.sleep(s);
  }

  const gotoOpts = {
    waitUntil: crawler.params.waitUntil,
    timeout: crawler.params.timeout
  };

  console.log(`Fetching HTML page ${url}`);
  try {
    await page.goto(url, gotoOpts);
    let timestamp = new Date().toISOString();
    await writeCapture({url, timestamp, isSeed, isHTML: true});
  } catch (e) {
    console.log(`Load timeout for ${url}`, e);
  }

  const screenShotDir = path.join(crawler.collDir, "screenshots");
  if (!fs.existsSync(screenShotDir)) {
    fs.mkdirSync(screenShotDir);
  }

  const screenshotWarcFile = path.join(screenShotDir, uuidv4() + ".warc.gz");
  const warcDate = new Date().toISOString();

  async function takeScreenshot({url, date, fullPage = false}) {
    const warcVersion = "WARC/1.1";
    const warcRecordType = "resource";
    const warcHeaders = {"Content-Type": "image/png"};
    let screenshotBuf = await page.screenshot({omitBackground: true, fullPage});
    async function* content() {
      yield screenshotBuf;
    }
    let screenshotUrl = "urn:screenshot:" + url;
    return warcio.WARCRecord.create({
      url: screenshotUrl,
      date,
      type: warcRecordType,
      warcVersion,
      warcHeaders}, content());
  }

  try {
    let record = await takeScreenshot({url, date: warcDate, fullPage: false});
    let recordBuf = await warcio.WARCSerializer.serialize(record, {gzip: true});
    fs.appendFileSync(screenshotWarcFile, recordBuf);
    let digest = record.warcPayloadDigest;
    console.log(`Screenshot for ${url} written to ${screenshotWarcFile}`);
    // full page screenshot
    record = await takeScreenshot({url, date: warcDate, fullPage: true});
    recordBuf = await warcio.WARCSerializer.serialize(record, {gzip: true});
    if (digest === record.warcPayloadDigest) {
      console.log(`Skipping full page screenshot for ${url} (identical to simple screenshot)`);
    } else {
      fs.appendFileSync(screenshotWarcFile, recordBuf);
      console.log(`Full page screenshot for ${url} written to ${screenshotWarcFile}`);
    }
  } catch (e) {
    console.log(`Screenshots failed for ${url}`, e);
  }

  if (!isSeed) {
    /* extract links only for the first page (limits crawl by depth 1),
       cf. https://github.com/webrecorder/browsertrix-crawler/issues/16 */
    return;
  }

  // fill seenList to avoid second visits of first-order links
  // (only re-crawl the homepage, already done)
  const seenList = path.join(crawler.collDir, "urls-seen.json");
  if (fs.existsSync(seenList)) {
    let seen = await JSON.parse(fs.readFileSync(seenList, "utf-8"));
    await seen.forEach(item => crawler.seenList.add(item));
    console.log(`Added ${seen.length} previously fetched URLs to seenList (now: ${crawler.seenList.size} items)`);
  }

  /**
    Modified version of @{link Crawler#extractLinks}:
    shuffles extracted links before queuing to ensure
    that consecutive crawls get links down on the page
    if there are more links than the limit and linked
    URLs change frequently.
  */
  async function extractLinks(page, selector = "a[href]") {
    let results = null;

    function shuffle(array) {
      for (let i = array.length - 1; i > 0; i--) {
        let j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
      }
    }

    try {
      results = await page.evaluate((selector) => {
        /* eslint-disable-next-line no-undef */
        return [...document.querySelectorAll(selector)].map(elem => elem.href);
      }, selector);
    } catch (e) {
      console.warn( `Link Extraction failed for ${url}`, e);
      return;
    }
    results = Array.from(results);

    let resultsUniq = new Set(results);
    console.info(`Extracted ${results.length} links (${resultsUniq.size} unique) from ${url}`);
    if (results.length > resultsUniq.size) {
      results = Array.from(resultsUniq);
    }

    shuffle(results);

    // dump link list for debugging
    const linkList = path.join(crawler.collDir, "links.json");
    fs.appendFileSync(linkList, JSON.stringify(results).concat("\n"));

    crawler.queueUrls(results);
  }

  // queue links
  await extractLinks(page, "a[href]");
};

