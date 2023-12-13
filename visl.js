const express = require('express');
const { getimageBufferPart, formatID } = require('./manager.js');
// const stream = require('stream');
const stream = require('node:stream');
// const { ControlBandwidth } = require('./limiter.js');
const router = express.Router();
const path = require('path');
//router.use(ControlBandwidth);
router.get('/file11', (req, res) => {
    res.sendFile(path.join(__dirname, '/h.html'));
});

router.get("/:cid/:fid", async function (req, res) {
    let range = req.headers.range;
    let { fid, cid } = req.params;
    
    fid = formatID(fid);
    if (cid.length !== 19 || fid.length !== 19) {
        return res.status(400).send("Ids are not valid.");
    }
    if (!cid || !fid) {
        return res.status(400).send("No fid or cid was specified");
    }
    if (!range) {
        range = 'bytes=0-';
    }
    
    let canceled = false;
    req.on('close', () => {
        canceled = true;
    });

    const start = Number(range.replace(/\D/g, ""));

    try {
        await new Promise(r => setTimeout(r, 50)); // accounting for sliding of video or audio
        if (canceled) {
            return res.status(200);
        }

        // Extract quality, width, and height from query parameters
        const { quality, width, height } = req.query;

        const data = await getimageBufferPart(fid, cid, start, { quality, width, height });

        if (!data) {
            console.log(`stream buffer not found!`);
            // return res.status(500).send("Could not get stream buffer");
        }

        const end = start + data.length;
        const contentLength = end - start;

        const headers = {
            "Content-Range": `bytes ${start}-${end - 1}/${data.streamSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": contentLength,
            "Content-Type": data.type,
            "Access-Control-Allow-Origin": "*",
            "Content-Disposition": `inline`,
        };

        res.writeHead(206, headers);

        var bufferStream = new stream.PassThrough();
        bufferStream.write(data.buffer);
        bufferStream.end(data.buffer);
        bufferStream.pipe(res);

    } catch (err) {
        console.log(err);
        res.status(500).json(err.message);
    }
});


module.exports = router;