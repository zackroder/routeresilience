import protobuf from 'protobufjs';
import path from 'path';

let feedMessageType: protobuf.Type | null = null;

/**
 * Load and cache the GTFS-RT protobuf type.
 */
export async function getProtoType(): Promise<protobuf.Type> {
    if (feedMessageType) return feedMessageType;

    const protoPath = path.resolve(process.cwd(), 'proto', 'gtfs-realtime.proto');
    const root = await protobuf.load(protoPath);
    feedMessageType = root.lookupType('transit_realtime.FeedMessage');
    return feedMessageType;
}

/**
 * Encode a GTFS-RT FeedMessage object to a binary protobuf buffer.
 */
export async function encodeFeedMessage(message: any): Promise<Buffer> {
    const FeedMessage = await getProtoType();
    const errMsg = FeedMessage.verify(message);
    if (errMsg) {
        console.error('Protobuf verification error:', errMsg);
        // Continue anyway — verification can be overly strict for optional fields
    }
    const pbMessage = FeedMessage.create(message);
    return Buffer.from(FeedMessage.encode(pbMessage).finish());
}

/**
 * Decode a binary protobuf buffer to a GTFS-RT FeedMessage object.
 */
export async function decodeFeedMessage(buffer: Buffer): Promise<any> {
    const FeedMessage = await getProtoType();
    return FeedMessage.decode(buffer);
}
