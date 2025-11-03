import socket
import threading
import time

class UDPListener:
    """
    Простий клас для прийому UDP-пакетів від ESP32.
    Можна запускати самостійно або імпортувати в інший скрипт (наприклад, Телеграм-бота).
    """

    def __init__(self, port: int = 5005, buffer_size: int = 1024):
        self.port = port
        self.buffer_size = buffer_size
        self.last_packet_time = 0
        self.running = False
        self.sock = None
        self.thread = None

        # callback-функції, які можна під’єднати з іншого коду
        self.on_packet = None        # викликається при отриманні пакета
        self.on_timeout = None       # можна викликати у своєму коді для перевірки "немає пакетів"

    def start(self):
        """Запускає приймач у фоновому потоці."""
        if self.running:
            return
        self.running = True
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("0.0.0.0", self.port))
        self.thread = threading.Thread(target=self._listen_loop, daemon=True)
        self.thread.start()
        print(f"[UDPListener] Listening on port {self.port}...")

    def _listen_loop(self):
        while self.running:
            try:
                data, addr = self.sock.recvfrom(self.buffer_size)
                msg = data.decode("utf-8").strip()
                self.last_packet_time = time.time()
                if self.on_packet:
                    self.on_packet(msg, addr)
                else:
                    print(f"[{time.strftime('%H:%M:%S')}] From {addr}: {msg}")
            except Exception as e:
                print("[UDPListener] Error:", e)
                time.sleep(0.5)

    def stop(self):
        """Акуратно зупиняє приймач."""
        self.running = False
        if self.sock:
            try:
                self.sock.close()
            except:
                pass
        print("[UDPListener] Stopped.")

    def seconds_since_last_packet(self) -> float:
        """Повертає кількість секунд з останнього пакета."""
        if self.last_packet_time == 0:
            return float("inf")
        return time.time() - self.last_packet_time


if __name__ == "__main__":
    # Якщо запустити напряму — працює у режимі консолі
    listener = UDPListener(port=5005)
    listener.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        listener.stop()
