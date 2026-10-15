package tormgr

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strconv"
	"time"
)

// proxyDialContext dials arbitrary destinations through the Tor SOCKS5
// listener. Used by the IP-discovery client so the observed address is the
// exit's, not the machine's.
func (m *Manager) proxyDialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port <= 0 || port > 65535 {
		return nil, fmt.Errorf("porta invalida %q", portStr)
	}
	return m.socks5Connect(ctx, host, port)
}

// socks5Connect performs a no-auth SOCKS5 CONNECT to host:port.
func (m *Manager) socks5Connect(ctx context.Context, host string, port int) (net.Conn, error) {
	dialer := net.Dialer{Timeout: 15 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", m.SocksAddr())
	if err != nil {
		return nil, fmt.Errorf("socks5 %s: %w", m.SocksAddr(), err)
	}
	if tc, ok := conn.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
	}
	deadline := time.Now().Add(30 * time.Second)
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}
	_ = conn.SetDeadline(deadline)

	// Greeting: version 5, one method (no auth).
	if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		_ = conn.Close()
		return nil, err
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("socks5 greeting: %w", err)
	}
	if reply[0] != 0x05 || reply[1] != 0x00 {
		_ = conn.Close()
		return nil, fmt.Errorf("socks5 recusou metodo (0x%02x)", reply[1])
	}

	// CONNECT request.
	request := []byte{0x05, 0x01, 0x00}
	ip := net.ParseIP(host)
	switch {
	case ip == nil:
		if len(host) > 255 {
			_ = conn.Close()
			return nil, fmt.Errorf("host longo demais: %q", host)
		}
		request = append(request, 0x03, byte(len(host)))
		request = append(request, []byte(host)...)
	case ip.To4() != nil:
		request = append(request, 0x01)
		request = append(request, ip.To4()...)
	default:
		request = append(request, 0x04)
		request = append(request, ip.To16()...)
	}
	request = binary.BigEndian.AppendUint16(request, uint16(port))
	if _, err := conn.Write(request); err != nil {
		_ = conn.Close()
		return nil, err
	}

	// Reply: VER REP RSV ATYP BND.ADDR BND.PORT
	head := make([]byte, 4)
	if _, err := io.ReadFull(conn, head); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("socks5 reply: %w", err)
	}
	if head[1] != 0x00 {
		_ = conn.Close()
		return nil, fmt.Errorf("socks5 CONNECT recusado (0x%02x)", head[1])
	}
	var skip int
	switch head[3] {
	case 0x01:
		skip = 4
	case 0x04:
		skip = 16
	case 0x03:
		length := make([]byte, 1)
		if _, err := io.ReadFull(conn, length); err != nil {
			_ = conn.Close()
			return nil, err
		}
		skip = int(length[0])
	default:
		_ = conn.Close()
		return nil, fmt.Errorf("socks5 atyp desconhecido 0x%02x", head[3])
	}
	if _, err := io.ReadFull(conn, make([]byte, skip+2)); err != nil {
		_ = conn.Close()
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, nil
}
