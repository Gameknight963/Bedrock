const { crc32 } = require('node:zlib');

function archive(entries) {
    const locals = [], directory = [];
    let offset = 0;
    for (const [name, content] of entries) {
        const filename = Buffer.from(name), data = Buffer.from(content);
        const local = Buffer.alloc(30), central = Buffer.alloc(46);
        local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
        local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
        central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 6);
        central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
        locals.push(local, filename, data); directory.push(central, filename);
        offset += local.length + filename.length + data.length;
    }
    const central = Buffer.concat(directory), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, central, end]);
}
module.exports = { archive };
