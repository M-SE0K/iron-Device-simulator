// fcntl.h — 시스템 헤더를 그대로 쓰되 MSVC 전용 _O_BINARY만 얹는다.
#pragma once
#include_next <fcntl.h>
#ifndef _O_BINARY
#define _O_BINARY 0
#endif
