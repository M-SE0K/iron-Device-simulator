// asiodrivers.h — SDK 2.3 host/asiodrivers.h + host/pc/asiolist.h의 타입체크 전용 스텁.
#pragma once

#include <windows.h>

class AsioDriverList {
 public:
  long asioGetNumDev();
  long asioGetDriverName(int index, char* name, int size);
  long asioGetDriverCLSID(int index, CLSID* clsid);
};

class AsioDrivers : public AsioDriverList {
 public:
  bool getCurrentDriverName(char* name);
  long getDriverNames(char** names, long maxDrivers);
  bool loadDriver(char* name);
  void removeCurrentDriver();
  long getCurrentDriverIndex();
};
