(module
 (type $0 (func (result i32)))
 (type $1 (func (param i32) (result i32)))
 (type $2 (func))
 (type $3 (func (param i32 i32 i32 i32 i32)))
 (type $4 (func (param i32 i32 i32 i32 i32 i32)))
 (memory $0 192)
 (export "idctSrcPtr" (func $asm/kernels/idctSrcPtr))
 (export "idctDstPtr" (func $asm/kernels/idctDstPtr))
 (export "maxYBytes" (func $asm/kernels/maxYBytes))
 (export "maxCBytes" (func $asm/kernels/maxCBytes))
 (export "planeYPtr" (func $asm/kernels/planeYPtr))
 (export "planeCrPtr" (func $asm/kernels/planeCrPtr))
 (export "planeCbPtr" (func $asm/kernels/planeCbPtr))
 (export "idct" (func $asm/kernels/idct))
 (export "idctAddBlock" (func $asm/kernels/idctAddBlock))
 (export "dcBlock" (func $asm/kernels/dcBlock))
 (export "memory" (memory $0))
 (func $asm/kernels/idctCore
  (local $0 i32)
  (local $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  (local $8 i32)
  (local $9 i32)
  (local $10 i32)
  (local $11 i32)
  (local $12 i32)
  (local $13 i32)
  (local $14 i32)
  (local $15 i32)
  loop $for-loop|0
   local.get $1
   i32.const 8
   i32.lt_s
   if
    local.get $1
    i32.const 3
    i32.shl
    local.tee $9
    i32.const 2
    i32.shl
    local.tee $0
    i32.const 1024
    i32.add
    i32.load
    local.set $2
    block $for-continue|0
     local.get $0
     i32.const 1052
     i32.add
     i32.load
     local.tee $10
     local.get $0
     i32.const 1048
     i32.add
     i32.load
     local.tee $11
     local.get $0
     i32.const 1044
     i32.add
     i32.load
     local.tee $12
     local.get $0
     i32.const 1040
     i32.add
     i32.load
     local.tee $13
     local.get $0
     i32.const 1036
     i32.add
     i32.load
     local.tee $14
     local.get $0
     i32.const 1028
     i32.add
     i32.load
     local.tee $15
     local.get $0
     i32.const 1032
     i32.add
     i32.load
     local.tee $3
     i32.or
     i32.or
     i32.or
     i32.or
     i32.or
     i32.or
     i32.eqz
     if
      local.get $0
      i32.const 1280
      i32.add
      local.get $2
      i32.const 19
      i32.shl
      i32.const 16
      i32.shr_s
      local.tee $2
      i32.store
      local.get $0
      i32.const 1284
      i32.add
      local.get $2
      i32.store
      local.get $0
      i32.const 1288
      i32.add
      local.get $2
      i32.store
      local.get $0
      i32.const 1292
      i32.add
      local.get $2
      i32.store
      local.get $0
      i32.const 1296
      i32.add
      local.get $2
      i32.store
      local.get $0
      i32.const 1300
      i32.add
      local.get $2
      i32.store
      local.get $0
      i32.const 1304
      i32.add
      local.get $2
      i32.store
      local.get $0
      i32.const 1308
      i32.add
      local.get $2
      i32.store
      br $for-continue|0
     end
     local.get $2
     i32.const 16383
     i32.mul
     i32.const 1024
     i32.add
     local.tee $0
     local.get $3
     i32.const 21407
     i32.mul
     local.tee $4
     i32.add
     local.set $2
     local.get $3
     i32.const 8867
     i32.mul
     local.tee $3
     local.get $0
     i32.add
     local.set $5
     local.get $0
     local.get $3
     i32.sub
     local.set $6
     local.get $0
     local.get $4
     i32.sub
     local.set $4
     local.get $15
     i32.const 22725
     i32.mul
     local.get $14
     i32.const 19266
     i32.mul
     i32.add
     local.set $7
     local.get $15
     i32.const 19266
     i32.mul
     local.get $14
     i32.const 4520
     i32.mul
     i32.sub
     local.set $8
     local.get $15
     i32.const 12873
     i32.mul
     local.get $14
     i32.const 22725
     i32.mul
     i32.sub
     local.set $3
     local.get $15
     i32.const 4520
     i32.mul
     local.get $14
     i32.const 12873
     i32.mul
     i32.sub
     local.set $0
     local.get $12
     local.get $13
     i32.or
     local.get $11
     i32.or
     local.get $10
     i32.or
     if
      local.get $5
      local.get $13
      i32.const 16383
      i32.mul
      local.tee $13
      local.get $11
      i32.const 21407
      i32.mul
      local.tee $14
      i32.add
      i32.sub
      local.set $5
      local.get $6
      local.get $13
      local.get $14
      i32.sub
      i32.sub
      local.set $6
      local.get $4
      local.get $13
      local.get $11
      i32.const 8867
      i32.mul
      local.tee $11
      i32.sub
      i32.add
      local.set $4
      local.get $7
      local.get $12
      i32.const 12873
      i32.mul
      local.get $10
      i32.const 4520
      i32.mul
      i32.add
      i32.add
      local.set $7
      local.get $8
      local.get $12
      i32.const 22725
      i32.mul
      local.get $10
      i32.const 12873
      i32.mul
      i32.add
      i32.sub
      local.set $8
      local.get $3
      local.get $12
      i32.const 4520
      i32.mul
      local.get $10
      i32.const 19266
      i32.mul
      i32.add
      i32.add
      local.set $3
      local.get $2
      local.get $11
      local.get $13
      i32.add
      i32.add
      local.set $2
      local.get $0
      local.get $12
      i32.const 19266
      i32.mul
      local.get $10
      i32.const 22725
      i32.mul
      i32.sub
      i32.add
      local.set $0
     end
     local.get $9
     i32.const 2
     i32.shl
     local.tee $9
     i32.const 1280
     i32.add
     local.get $2
     local.get $7
     i32.add
     i32.const 11
     i32.shr_s
     i32.store
     local.get $9
     i32.const 1308
     i32.add
     local.get $2
     local.get $7
     i32.sub
     i32.const 11
     i32.shr_s
     i32.store
     local.get $9
     i32.const 1284
     i32.add
     local.get $5
     local.get $8
     i32.add
     i32.const 11
     i32.shr_s
     i32.store
     local.get $9
     i32.const 1304
     i32.add
     local.get $5
     local.get $8
     i32.sub
     i32.const 11
     i32.shr_s
     i32.store
     local.get $9
     i32.const 1288
     i32.add
     local.get $3
     local.get $6
     i32.add
     i32.const 11
     i32.shr_s
     i32.store
     local.get $9
     i32.const 1300
     i32.add
     local.get $6
     local.get $3
     i32.sub
     i32.const 11
     i32.shr_s
     i32.store
     local.get $9
     i32.const 1292
     i32.add
     local.get $0
     local.get $4
     i32.add
     i32.const 11
     i32.shr_s
     i32.store
     local.get $9
     i32.const 1296
     i32.add
     local.get $4
     local.get $0
     i32.sub
     i32.const 11
     i32.shr_s
     i32.store
    end
    local.get $1
    i32.const 1
    i32.add
    local.set $1
    br $for-loop|0
   end
  end
  i32.const 0
  local.set $3
  loop $for-loop|1
   local.get $3
   i32.const 8
   i32.lt_s
   if
    local.get $3
    i32.const 2
    i32.shl
    local.tee $9
    i32.const 1440
    i32.add
    i32.load
    local.set $10
    local.get $9
    i32.const 1472
    i32.add
    i32.load
    local.set $11
    local.get $9
    i32.const 1504
    i32.add
    i32.load
    local.set $12
    local.get $9
    i32.const 1344
    i32.add
    i32.load
    local.tee $0
    i32.const 21407
    i32.mul
    local.tee $2
    local.get $9
    i32.const 1280
    i32.add
    i32.load
    i32.const 32
    i32.add
    i32.const 16383
    i32.mul
    local.tee $4
    i32.add
    local.set $1
    local.get $0
    i32.const 8867
    i32.mul
    local.tee $0
    local.get $4
    i32.add
    local.set $5
    local.get $4
    local.get $0
    i32.sub
    local.set $6
    local.get $4
    local.get $2
    i32.sub
    local.set $4
    local.get $9
    i32.const 1312
    i32.add
    i32.load
    local.tee $0
    i32.const 22725
    i32.mul
    local.get $9
    i32.const 1376
    i32.add
    i32.load
    local.tee $13
    i32.const 19266
    i32.mul
    i32.add
    local.set $7
    local.get $0
    i32.const 19266
    i32.mul
    local.get $13
    i32.const 4520
    i32.mul
    i32.sub
    local.set $8
    local.get $0
    i32.const 12873
    i32.mul
    local.get $13
    i32.const 22725
    i32.mul
    i32.sub
    local.set $2
    local.get $0
    i32.const 4520
    i32.mul
    local.get $13
    i32.const 12873
    i32.mul
    i32.sub
    local.set $0
    local.get $9
    i32.const 1408
    i32.add
    i32.load
    local.tee $9
    if
     local.get $5
     local.get $9
     i32.const 16383
     i32.mul
     local.tee $9
     i32.sub
     local.set $5
     local.get $6
     local.get $9
     i32.sub
     local.set $6
     local.get $4
     local.get $9
     i32.add
     local.set $4
     local.get $1
     local.get $9
     i32.add
     local.set $1
    end
    local.get $10
    if
     local.get $8
     local.get $10
     i32.const 22725
     i32.mul
     i32.sub
     local.set $8
     local.get $2
     local.get $10
     i32.const 4520
     i32.mul
     i32.add
     local.set $2
     local.get $7
     local.get $10
     i32.const 12873
     i32.mul
     i32.add
     local.set $7
     local.get $0
     local.get $10
     i32.const 19266
     i32.mul
     i32.add
     local.set $0
    end
    local.get $11
    if
     local.get $5
     local.get $11
     i32.const 21407
     i32.mul
     local.tee $9
     i32.sub
     local.set $5
     local.get $6
     local.get $9
     i32.add
     local.set $6
     local.get $4
     local.get $11
     i32.const 8867
     i32.mul
     local.tee $9
     i32.sub
     local.set $4
     local.get $1
     local.get $9
     i32.add
     local.set $1
    end
    local.get $12
    if
     local.get $8
     local.get $12
     i32.const 12873
     i32.mul
     i32.sub
     local.set $8
     local.get $2
     local.get $12
     i32.const 19266
     i32.mul
     i32.add
     local.set $2
     local.get $7
     local.get $12
     i32.const 4520
     i32.mul
     i32.add
     local.set $7
     local.get $0
     local.get $12
     i32.const 22725
     i32.mul
     i32.sub
     local.set $0
    end
    local.get $3
    i32.const 2
    i32.shl
    local.tee $9
    i32.const 1280
    i32.add
    local.get $1
    local.get $7
    i32.add
    i32.const 20
    i32.shr_s
    i32.store
    local.get $9
    i32.const 1312
    i32.add
    local.get $5
    local.get $8
    i32.add
    i32.const 20
    i32.shr_s
    i32.store
    local.get $9
    i32.const 1344
    i32.add
    local.get $2
    local.get $6
    i32.add
    i32.const 20
    i32.shr_s
    i32.store
    local.get $9
    i32.const 1376
    i32.add
    local.get $0
    local.get $4
    i32.add
    i32.const 20
    i32.shr_s
    i32.store
    local.get $9
    i32.const 1408
    i32.add
    local.get $4
    local.get $0
    i32.sub
    i32.const 20
    i32.shr_s
    i32.store
    local.get $9
    i32.const 1440
    i32.add
    local.get $6
    local.get $2
    i32.sub
    i32.const 20
    i32.shr_s
    i32.store
    local.get $9
    i32.const 1472
    i32.add
    local.get $5
    local.get $8
    i32.sub
    i32.const 20
    i32.shr_s
    i32.store
    local.get $9
    i32.const 1504
    i32.add
    local.get $1
    local.get $7
    i32.sub
    i32.const 20
    i32.shr_s
    i32.store
    local.get $3
    i32.const 1
    i32.add
    local.set $3
    br $for-loop|1
   end
  end
 )
 (func $asm/kernels/planeYPtr (param $0 i32) (result i32)
  local.get $0
  i32.const 4177920
  i32.mul
  i32.const 1536
  i32.add
 )
 (func $asm/kernels/planeCrPtr (param $0 i32) (result i32)
  local.get $0
  i32.const 4177920
  i32.mul
  i32.const 2090496
  i32.add
 )
 (func $asm/kernels/planeCbPtr (param $0 i32) (result i32)
  local.get $0
  i32.const 4177920
  i32.mul
  i32.const 3134976
  i32.add
 )
 (func $asm/kernels/maxYBytes (result i32)
  i32.const 2088960
 )
 (func $asm/kernels/maxCBytes (result i32)
  i32.const 1044480
 )
 (func $asm/kernels/idctSrcPtr (result i32)
  i32.const 1024
 )
 (func $asm/kernels/idctDstPtr (result i32)
  i32.const 1280
 )
 (func $asm/kernels/idctAddBlock (param $0 i32) (param $1 i32) (param $2 i32) (param $3 i32) (param $4 i32)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  (local $8 i32)
  call $asm/kernels/idctCore
  local.get $3
  if
   loop $for-loop|0
    local.get $5
    i32.const 8
    i32.lt_s
    if
     i32.const 0
     local.set $3
     loop $for-loop|1
      local.get $3
      i32.const 8
      i32.lt_s
      if
       local.get $1
       local.get $3
       i32.add
       local.tee $7
       local.get $4
       i32.lt_s
       local.get $7
       i32.const 0
       i32.ge_s
       i32.and
       if
        local.get $0
        local.get $7
        i32.add
        i32.const 255
        local.get $3
        local.get $6
        i32.add
        i32.const 2
        i32.shl
        i32.const 1280
        i32.add
        i32.load
        local.tee $7
        local.get $7
        i32.const 255
        i32.gt_s
        select
        i32.const 0
        local.get $7
        i32.const 0
        i32.ge_s
        select
        i32.store8
       end
       local.get $3
       i32.const 1
       i32.add
       local.set $3
       br $for-loop|1
      end
     end
     local.get $6
     i32.const 8
     i32.add
     local.set $6
     local.get $1
     local.get $2
     i32.const 8
     i32.add
     i32.add
     local.set $1
     local.get $5
     i32.const 1
     i32.add
     local.set $5
     br $for-loop|0
    end
   end
  else
   loop $for-loop|2
    local.get $5
    i32.const 8
    i32.lt_s
    if
     i32.const 0
     local.set $3
     loop $for-loop|3
      local.get $3
      i32.const 8
      i32.lt_s
      if
       local.get $1
       local.get $3
       i32.add
       local.tee $7
       local.get $4
       i32.lt_s
       local.get $7
       i32.const 0
       i32.ge_s
       i32.and
       if
        local.get $3
        local.get $6
        i32.add
        i32.const 2
        i32.shl
        i32.const 1280
        i32.add
        i32.load
        local.get $0
        local.get $7
        i32.add
        local.tee $8
        i32.load8_u
        i32.add
        local.set $7
        local.get $8
        i32.const 255
        local.get $7
        local.get $7
        i32.const 255
        i32.gt_s
        select
        i32.const 0
        local.get $7
        i32.const 0
        i32.ge_s
        select
        i32.store8
       end
       local.get $3
       i32.const 1
       i32.add
       local.set $3
       br $for-loop|3
      end
     end
     local.get $6
     i32.const 8
     i32.add
     local.set $6
     local.get $1
     local.get $2
     i32.const 8
     i32.add
     i32.add
     local.set $1
     local.get $5
     i32.const 1
     i32.add
     local.set $5
     br $for-loop|2
    end
   end
  end
 )
 (func $asm/kernels/idct
  call $asm/kernels/idctCore
 )
 (func $asm/kernels/dcBlock (param $0 i32) (param $1 i32) (param $2 i32) (param $3 i32) (param $4 i32) (param $5 i32)
  (local $6 i32)
  (local $7 i32)
  (local $8 i32)
  local.get $3
  if
   i32.const 255
   local.get $4
   local.get $4
   i32.const 255
   i32.gt_s
   select
   i32.const 0
   local.get $4
   i32.const 0
   i32.ge_s
   select
   local.set $4
   loop $for-loop|0
    local.get $6
    i32.const 8
    i32.lt_s
    if
     i32.const 0
     local.set $3
     loop $for-loop|1
      local.get $3
      i32.const 8
      i32.lt_s
      if
       local.get $1
       local.get $3
       i32.add
       local.tee $7
       local.get $5
       i32.lt_s
       local.get $7
       i32.const 0
       i32.ge_s
       i32.and
       if
        local.get $0
        local.get $7
        i32.add
        local.get $4
        i32.store8
       end
       local.get $3
       i32.const 1
       i32.add
       local.set $3
       br $for-loop|1
      end
     end
     local.get $1
     local.get $2
     i32.const 8
     i32.add
     i32.add
     local.set $1
     local.get $6
     i32.const 1
     i32.add
     local.set $6
     br $for-loop|0
    end
   end
  else
   loop $for-loop|2
    local.get $6
    i32.const 8
    i32.lt_s
    if
     i32.const 0
     local.set $3
     loop $for-loop|3
      local.get $3
      i32.const 8
      i32.lt_s
      if
       local.get $1
       local.get $3
       i32.add
       local.tee $7
       local.get $5
       i32.lt_s
       local.get $7
       i32.const 0
       i32.ge_s
       i32.and
       if
        local.get $0
        local.get $7
        i32.add
        local.tee $8
        i32.load8_u
        local.get $4
        i32.add
        local.set $7
        local.get $8
        i32.const 255
        local.get $7
        local.get $7
        i32.const 255
        i32.gt_s
        select
        i32.const 0
        local.get $7
        i32.const 0
        i32.ge_s
        select
        i32.store8
       end
       local.get $3
       i32.const 1
       i32.add
       local.set $3
       br $for-loop|3
      end
     end
     local.get $1
     local.get $2
     i32.const 8
     i32.add
     i32.add
     local.set $1
     local.get $6
     i32.const 1
     i32.add
     local.set $6
     br $for-loop|2
    end
   end
  end
 )
)
