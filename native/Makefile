# ff_prot 참조 구현 빌드 (검증용 libirontune.so 스텁)
#
#   make            # libirontune.so 생성 (native-engine.ts 가 로드하는 이름)
#   make selftest   # 순수 C 셀프테스트 바이너리 생성 후 ./selftest 로 확인
#   make clean
#
# ⚠️ Linux x86-64 전용. macOS/Apple Silicon 에서는 Docker(x86-64)로 빌드할 것.
#    (scripts/run-native-docker.sh 와 동일한 실행 환경 규약)

CC      ?= gcc
CFLAGS  ?= -O2 -Wall -Wextra -fPIC -std=c99
LDFLAGS ?= -shared
LIBS    ?= -lm

SO_NAME := libirontune.so

.PHONY: all selftest clean

all: $(SO_NAME)

$(SO_NAME): ff_prot.c ff_prot.h
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ ff_prot.c $(LIBS)

selftest: ff_prot.c ff_prot.h selftest.c
	$(CC) $(CFLAGS) -o selftest ff_prot.c selftest.c $(LIBS)
	./selftest

clean:
	rm -f $(SO_NAME) selftest
