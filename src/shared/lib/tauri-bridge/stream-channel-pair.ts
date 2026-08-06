import { Channel } from "@tauri-apps/api/core";
import { ChannelHub } from "./channel-registry";

export function createStreamChannelPair() {
  const dataHub = new ChannelHub<Uint8Array>();

  return {
    createChannels: () => {
      dataHub.reset();

      const dataChannel = new Channel<ArrayBuffer>();
      dataChannel.onmessage = (buffer) => dataHub.dispatch(new Uint8Array(buffer));

      return { dataChannel };
    },
    onData: (callback: (data: Uint8Array) => void) => dataHub.subscribe(callback),
  };
}
