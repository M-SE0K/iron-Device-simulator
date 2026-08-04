import { Channel } from "@tauri-apps/api/core";
import { ChannelHub } from "./channel-registry";

export function createStreamChannelPair<TMark>() {
  const dataHub = new ChannelHub<Uint8Array>();
  const markHub = new ChannelHub<TMark>();

  return {
    createChannels: () => {
      dataHub.reset();
      markHub.reset();

      const dataChannel = new Channel<ArrayBuffer>();
      dataChannel.onmessage = (buffer) => dataHub.dispatch(new Uint8Array(buffer));

      const markChannel = new Channel<TMark>();
      markChannel.onmessage = (mark) => markHub.dispatch(mark);

      return { dataChannel, markChannel };
    },
    onData: (callback: (data: Uint8Array) => void) => dataHub.subscribe(callback),
    onMark: (callback: (mark: TMark) => void) => markHub.subscribe(callback),
  };
}
